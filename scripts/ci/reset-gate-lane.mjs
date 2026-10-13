#!/usr/bin/env node
// Parent-authorized cold-lane recovery (reconciliation) for a gate boundary whose
// durable owner record is stuck in a non-RELEASED state. Canonical trigger: a CI
// run cancelled mid-gate (2026-10-10: lane1 owner stuck ACTIVE after cancel;
// assertAdmissionPredecessor requires RELEASED with no expiry amnesty, so the
// lane fail-closes forever until this reconciliation).
//
// EXECUTED BY THE HUMAN OPERATOR ONLY — same rule as initialize-gate-lane2.mjs:
// running this script IS the parent decision, and --decision records what that
// decision was based on (a file path whose sha256 is pinned into the new
// authority.json, or a bare 64-hex digest). Agents must not self-authorize.
//
// What it does for --lane 1|2:
//   0. refuses when there is nothing to recover (no owner, or already RELEASED);
//   1. refuses when the owner window can still be live (holdDeadline not yet
//      passed on this boot) — a live holder must settle by itself, never reset;
//   2. archives the whole durable root to <root>.quarantine-<UTC-ts> (evidence
//      is moved out of the live path, never deleted);
//   3. re-initializes the boundary exactly like first-initialization (container
//      identity pinned, fresh authority.json + initialization.json);
//   4. rewrites the lane allocation file (initializationId/authorityRef are
//      pinned fail-closed, so the pre-reset allocation is invalid by design).
//
// Usage (as the operator, from the repo checkout containing this script):
//   node scripts/ci/reset-gate-lane.mjs --lane 1 \
//     --decision /absolute/incident-and-decision.md [--dry-run]
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { acquireLock, initializeGate, monotonicMs, ownerStore, readJSON, GATE_BOUNDARIES } from './redis.mjs';

const run = promisify(execFile);
const fail = message => { console.error(`ERROR: ${message}`); process.exit(1); };
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).exec(value)?.[0] === value;
const ALLOCATION_DEFAULTS = {
  1: '/opt/ci-env/allocations/lane1.json',
  2: '/opt/ci-env/allocations/lane2.json',
};

const { values } = parseArgs({ options: {
  lane: { type: 'string' },
  decision: { type: 'string' },
  'initialization-id': { type: 'string' },
  'allocation-out': { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
} });
if (values.lane !== '1' && values.lane !== '2') fail('--lane must be 1 or 2');
if (!values.decision) fail('--decision is required (absolute file path or 64-hex digest of the parent decision)');
const lane = GATE_BOUNDARIES[Number(values.lane) - 1];
if (!lane) fail(`lane boundary ${values.lane} is not defined`);
const allocationOut = values['allocation-out'] ?? ALLOCATION_DEFAULTS[Number(values.lane)];
const decisionPath = isAbsolute(values.decision) ? values.decision : resolve(process.cwd(), values.decision);
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

// 0. There must be a stuck (non-RELEASED) owner to recover.
let owner;
try { owner = JSON.parse(await readFile(lane.ownerPath, 'utf8')); }
catch { fail(`no readable owner record at ${lane.ownerPath}; nothing to recover (first initialization: scripts/ci/initialize-gate-lane.mjs --lane N)`); }
if (owner.state === 'RELEASED') fail(`owner state is already RELEASED (epoch ${(owner.epoch ?? '').slice(0, 8)}); the lane admits normally — no recovery needed`);

// 1. The owner window must be fully past on this boot: a holder whose
//    holdDeadline has not expired may still be live and must settle itself.
const now = monotonicMs();
const window = owner.window ?? {};
if (typeof window.anchorMs === 'number' && window.anchorMs <= now
  && typeof window.holdDeadlineMs === 'number' && window.holdDeadlineMs > now) {
  fail(`owner window is still live (holdDeadline in ${Math.round((window.holdDeadlineMs - now) / 1000)}s); refuse to reset a possibly-held lane`);
}
const quarantine = `${lane.root}.quarantine-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
console.log(`lane ${values.lane} (${lane.service} ${lane.host}:${lane.port}) recovery plan:`);
console.log(`  stuck owner     : state=${owner.state} epoch=${(owner.epoch ?? '?').slice(0, 8)} runId=${owner.runId ?? '?'}`);
console.log(`  window          : anchor=${window.anchorMs ?? '?'} holdDeadline=${window.holdDeadlineMs ?? '?'} now=${now}`);
console.log(`  quarantine      : ${quarantine}`);
console.log(`  re-init as      : initializationId=${initializationId} decision=${decisionDigest.slice(0, 16)}…`);
console.log(`  allocation-out  : ${allocationOut}`);
if (values['dry-run']) { console.log('dry-run: nothing mutated'); process.exit(0); }

// 2. Container identity must still pin this lane (same rule as initialization).
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

// 3. Archive the durable root out of the live path, then first-initialize.
try { await stat(quarantine); fail(`quarantine target already exists: ${quarantine}`); } catch { /* absent as required */ }
await rename(lane.root, quarantine);
try { await stat(lane.lockPath); }
catch { const carrier = await open(lane.lockPath, 'wx', 0o600); await carrier.close(); }
const store = ownerStore(lane.ownerPath, { boundary: lane });
const holder = await acquireLock({ path: lane.lockPath, deadline: monotonicMs() + 30_000 });
try {
  await initializeGate({ initializationId, parentDecisionSha256: decisionDigest }, holder, { store });
} finally {
  const outcome = await holder.release();
  if (outcome.status !== 'UNLOCKED') fail(`lock release status ${outcome.status}; durable state may need reconciliation before retrying`);
}

// 4. Publish the fresh allocation the runners will use.
const initial = await store.initialization();
const allocation = { version: 2, initializationId, purpose: 'ci', mode: 'borrowed-exclusive-db', service: lane.service,
  host: lane.host, port: lane.port, db: lane.namespaces.ci, ownerPath: lane.ownerPath, lockPath: lane.lockPath,
  containerId, serverRunId, authorityRef: initial.authorityRef };
await writeFile(allocationOut, `${JSON.stringify(allocation, null, 2)}\n`, { mode: 0o600 });
const reread = await readJSON(allocationOut);
console.log(`lane ${values.lane} gate boundary recovered (parent-authorized)`);
console.log(`  initializationId : ${initializationId}`);
console.log(`  containerId      : ${containerId}`);
console.log(`  serverRunId      : ${serverRunId}`);
console.log(`  authority.json   : ${initial.authorityRef.path} (sha256 ${initial.authorityRef.sha256.slice(0, 16)}…)`);
console.log(`  allocation       : ${allocationOut}`);
console.log(`  re-read check    : service=${reread.service} port=${reread.port} db=${reread.db}`);
console.log(`  evidence archive : ${quarantine}`);
