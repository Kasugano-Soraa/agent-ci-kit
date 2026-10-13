#!/usr/bin/env node
// Parent-authorized one-shot initializer for a gate boundary (lane 1 or 2).
// The boundary tuple (service, host, port, durable root, lock) is declared in
// redis.mjs's GATE_BOUNDARIES; this script initializes the chosen lane's
// durable root and publishes the allocation file the CI runners will use.
//
// EXECUTED BY THE HUMAN OPERATOR ONLY. The gate protocol forbids agents from
// self-authorizing a new durable boundary: running this script IS the parent
// decision, and --decision records what that decision was based on (a file
// path whose sha256 is pinned into authority.json, or a bare 64-hex digest).
//
// Idempotence is deliberately NOT provided: a partial/existing root is never
// reset (EEXIST stays an error; reconciliation is a separate manual protocol —
// reset-gate-lane.mjs). The lock file is created before use because acquireLock
// opens it without O_CREAT — a lock file is a plain flock carrier, not
// authorization.
//
// Usage (as the operator, from the repo checkout containing this script):
//   node scripts/ci/initialize-gate-lane.mjs --lane 1 \
//     --decision /absolute/decision-document.md \
//     [--initialization-id <32-hex>] \
//     [--allocation-out /opt/ci-env/allocations/lane1.json]
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, writeFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { acquireLock, initializeGate, monotonicMs, ownerStore, readJSON, GATE_BOUNDARIES } from './redis.mjs';

const run = promisify(execFile);
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).exec(value)?.[0] === value;
const fail = message => { console.error(`ERROR: ${message}`); process.exit(1); };

const { values } = parseArgs({ options: {
  'lane': { type: 'string' },
  'decision': { type: 'string' },
  'initialization-id': { type: 'string' },
  'allocation-out': { type: 'string' },
} });
if (values.lane !== '1' && values.lane !== '2') fail('--lane must be 1 or 2');
const lane = GATE_BOUNDARIES[Number(values.lane) - 1];
if (!lane) fail(`lane boundary ${values.lane} is not defined`);
const allocationOut = values['allocation-out'] ?? `/opt/ci-env/allocations/lane${values.lane}.json`;
if (!values.decision) fail('--decision is required (absolute file path or 64-hex digest of the parent decision)');
const decisionPath = isAbsolute(values.decision) ? values.decision : resolve(process.cwd(), values.decision);
// Read the decision file (or accept the bare digest) without printing content.
let decisionDigest;
if (hex(values.decision, 64)) decisionDigest = values.decision;
else {
  let text;
  try { text = await (await open(decisionPath, 'r')).readFile('utf8'); }
  catch { fail(`cannot read decision document: ${decisionPath}`); }
  decisionDigest = createHash('sha256').update(text).digest('hex');
}
const initializationId = values['initialization-id'] ?? randomBytes(16).toString('hex');
if (!hex(initializationId, 32)) fail('--initialization-id must be 32 hex chars');

// 1. The lane2 container must be the one this allocation pins: exact identity,
//    running, and mapped on the declared lane port.
const format = '{"id":{{json .Id}},"running":{{json .State.Running}},"ports":{{json (index .NetworkSettings.Ports "6379/tcp")}}}';
let inspect;
try { inspect = JSON.parse((await run('/usr/bin/docker', ['inspect', '--format', format, lane.service], { timeout: 2000 })).stdout); }
catch { fail(`docker container ${lane.service} is not inspectable (start it first; see README → Operations)`); }
if (inspect.running !== true) fail(`container ${lane.service} is not running`);
if (!Array.isArray(inspect.ports) || inspect.ports.length !== 1
  || inspect.ports[0].HostIp !== lane.host || inspect.ports[0].HostPort !== String(lane.port)) {
  fail(`container ${lane.service} port mapping is not ${lane.host}:${lane.port}`);
}
const containerId = inspect.id;
const server = await run('/usr/bin/docker', ['exec', lane.service, 'redis-cli', 'INFO', 'server'], { timeout: 2000 });
const serverRunId = server.stdout.split(/\r?\n/).find(line => line.startsWith('run_id:'))?.slice(7);
if (!hex(serverRunId, 40)) fail(`cannot read a 40-hex run_id from container ${lane.service}`);

// 2. Plain flock carrier for the lane2 boundary (mirrors the lane1 lock file).
try { await stat(lane.lockPath); }
catch { const carrier = await open(lane.lockPath, 'wx', 0o600); await carrier.close(); }

// 3. Initialize the durable root under the held lock, then release.
const store = ownerStore(lane.ownerPath, { boundary: lane });
const holder = await acquireLock({ path: lane.lockPath, deadline: monotonicMs() + 30_000 });
try {
  await initializeGate({ initializationId, parentDecisionSha256: decisionDigest }, holder, { store });
} finally {
  const outcome = await holder.release();
  if (outcome.status !== 'UNLOCKED') fail(`lock release status ${outcome.status}; durable state may need reconciliation before retrying`);
}

// 4. Publish the lane allocation the runners will use. The authorityRef
//    digest comes from the just-written immutable authority.json.
const initial = await store.initialization();
const allocation = { version: 2, initializationId, purpose: 'ci', mode: 'borrowed-exclusive-db', service: lane.service,
  host: lane.host, port: lane.port, db: lane.namespaces.ci, ownerPath: lane.ownerPath, lockPath: lane.lockPath,
  containerId, serverRunId, authorityRef: initial.authorityRef };
await writeFile(allocationOut, `${JSON.stringify(allocation, null, 2)}\n`, { mode: 0o600 });
const reread = await readJSON(allocationOut);
console.log(`lane ${values.lane} gate boundary initialized (parent-authorized one-shot)`);
console.log(`  initializationId : ${initializationId}`);
console.log(`  containerId      : ${containerId}`);
console.log(`  serverRunId      : ${serverRunId}`);
console.log(`  authority.json   : ${initial.authorityRef.path} (sha256 ${initial.authorityRef.sha256.slice(0, 16)}…)`);
console.log(`  allocation       : ${values['allocation-out']}`);
console.log(`  re-read check    : service=${reread.service} port=${reread.port} db=${reread.db}`);
