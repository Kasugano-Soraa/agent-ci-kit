import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { open, readFile, rename, rm, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

// ─── Deployment facts ─────────────────────────────────────────────────────────
// The block below pins THIS deployment's durable-gate geometry (paths, service
// names, ports, DB namespaces). It is deliberately NOT input-configurable: an
// allocation can only match a declared lane byte-for-byte, so no CI input can
// relocate or invent a boundary. Adapt the paths/services to your host when you
// adopt this kit, then leave them stable — lanes are initialized once (see
// initialize-gate-lane2.mjs / reset-gate-lane.mjs).
// ─────────────────────────────────────────────────────────────────────────────
// Fixed durable state shared with formal; ordinary input cannot relocate/init it.
export const GATE_ROOT = '/var/lib/agent-ci-kit/shared-gate';
export const GATE_OWNER_PATH = `${GATE_ROOT}/owner.json`;
export const GATE_AUTHORITY_PATH = `${GATE_ROOT}/authority.json`;
export const GATE_LOCK_PATH = '/var/lib/agent-ci-kit/locks/redis-integration.lock';
// A gate boundary is the exact (service, host, port, namespaces, durable root,
// lock) tuple one borrowed lane runs on. Boundaries are declared here and only
// here: allocations must match a declared lane exactly, so an allocation input
// can never relocate or invent a slot. The default lane equals today's
// constants byte for byte; every boundary below is frozen.
export const GATE_BOUNDARY = Object.freeze({ service: 'gate-redis', host: '127.0.0.1', port: 16379,
  namespaces: Object.freeze({ ci: 13, formal: 14 }), root: GATE_ROOT,
  ownerPath: GATE_OWNER_PATH, authorityPath: GATE_AUTHORITY_PATH, lockPath: GATE_LOCK_PATH });
export const GATE_BOUNDARIES = Object.freeze([
  GATE_BOUNDARY,
  Object.freeze({ service: 'gate-redis-ci2', host: '127.0.0.1', port: 16380,
    namespaces: Object.freeze({ ci: 13, formal: 14 }), root: '/var/lib/agent-ci-kit/shared-gate-lane2',
    ownerPath: '/var/lib/agent-ci-kit/shared-gate-lane2/owner.json',
    authorityPath: '/var/lib/agent-ci-kit/shared-gate-lane2/authority.json',
    lockPath: '/var/lib/agent-ci-kit/locks/redis-integration-lane2.lock' }),
]);
// Normalizes a boundary input to the declared member it equals, or rejects it.
export function gateBoundary(candidate) {
  const found = GATE_BOUNDARIES.find(lane => JSON.stringify(candidate) === JSON.stringify(lane));
  check(found, 'Unknown gate boundary');
  return found;
}
export const BUDGETS = Object.freeze({ ci: Object.freeze([1_800_000, 120_000, 30_000]), formal: Object.freeze([3_750_000, 120_000, 30_000]) });
export const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const digest = text => createHash('sha256').update(text).digest('hex');
const parse = raw => { try { return typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw); } catch { throw new Error('Invalid non-secret JSON schema'); } };
const full = (pattern, value) => typeof value === 'string' && new RegExp(`^(?:${pattern})$`, 'u').exec(value)?.[0] === value;
const hex = (value, length) => full(`[a-f0-9]{${length}}`, value);
const check = (ok, code) => { if (!ok) throw new Error(code); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const states = ['ACTIVE', 'QUIESCING', 'CLEANING', 'RELEASED', 'UNRESOLVED'];
const only = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
const reference = ref => only(ref, ['path', 'sha256']) && typeof ref.path === 'string' && isAbsolute(ref.path) && hex(ref.sha256, 64);
const utcNow = () => new Date().toISOString();

export async function readJSON(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size <= 1_048_576, 'Invalid evidence file');
    return parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function immutableJSON(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return { path: resolve(path), sha256: digest(text) };
}

async function readReference(ref, { json = true } = {}) {
  check(reference(ref), 'Invalid evidence reference');
  const file = await open(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size <= 1_048_576, 'Evidence exceeds limit');
    const text = await file.readFile('utf8');
    check(digest(text) === ref.sha256, 'Evidence digest mismatch');
    return json ? parse(text) : text;
  } finally { await file.close(); }
}

export function parseGateOwner(raw, { boundary = GATE_BOUNDARY } = {}) {
  const gate = gateBoundary(boundary);
  const o = parse(raw);
  check(only(o, ['version', 'initializationId', 'epoch', 'revision', 'purpose', 'state', 'runId', 'authorityRef', 'instance', 'namespace', 'holder', 'window', 'evidence'])
    && o.version === 2 && hex(o.initializationId, 32) && ['ci', 'formal'].includes(o.purpose) && states.includes(o.state), 'Invalid common owner schema');
  check(only(o.instance, ['host', 'port', 'containerId', 'serverRunId']) && only(o.namespace, ['redisDb', 'exclusive'])
    && only(o.holder, ['pid', 'startTicks', 'bootId', 'lockPath', 'state', 'guardianPid', 'guardianStartTicks'])
    && only(o.window, ['clock', 'bootId', 'admittedAt', 'anchorMs', 'workDeadlineMs', 'cleanupDeadlineMs', 'holdDeadlineMs'])
    && only(o.evidence, ['admission', 'lifecycle', 'terminal']) && Object.values(o.evidence).every(reference), 'Invalid common owner fields');
  check(hex(o.epoch, 32) && integer(o.revision) && o.revision > 0 && full('[A-Za-z0-9_-]{1,128}', o.runId), 'Invalid owner identity');
  check(reference(o.authorityRef) && o.authorityRef.path === gate.authorityPath && reference(o.evidence?.admission), 'Invalid owner references');
  for (const [kind, ref] of Object.entries(o.evidence)) {
    check(ref.path === `${gate.root}/receipts/${o.epoch}/${kind}.json`, 'Required evidence must be durable and epoch-bound');
  }
  check(o.instance?.host === gate.host && o.instance.port === gate.port
    && hex(o.instance.containerId, 64) && hex(o.instance.serverRunId, 40), 'Invalid gate identity');
  check(o.namespace?.redisDb === (o.purpose === 'ci' ? gate.namespaces.ci : gate.namespaces.formal) && o.namespace.exclusive === true, 'Invalid owner namespace');
  check(o.holder?.lockPath === gate.lockPath && integer(o.holder.pid) && o.holder.pid > 0
    && full('[0-9]+', o.holder.startTicks) && full('[a-f0-9-]{36}', o.holder.bootId), 'Invalid lock holder');
  check((o.holder.state === undefined || full('[RSDZTtXxKWPI]', o.holder.state))
    && (o.holder.guardianPid === undefined && o.holder.guardianStartTicks === undefined
      || integer(o.holder.guardianPid) && o.holder.guardianPid > 0 && full('[0-9]+', o.holder.guardianStartTicks)), 'Invalid guardian identity');
  const w = o.window, [work, cleanup, tail] = BUDGETS[o.purpose];
  check(w?.clock === 'linux-monotonic-ms' && w.bootId === o.holder.bootId
    && typeof w.admittedAt === 'string' && w.admittedAt.endsWith('Z') && Number.isFinite(Date.parse(w.admittedAt))
    && [w.anchorMs, w.workDeadlineMs, w.cleanupDeadlineMs, w.holdDeadlineMs].every(integer) && w.workDeadlineMs > w.anchorMs
    && w.workDeadlineMs <= w.anchorMs + work && w.cleanupDeadlineMs === w.workDeadlineMs + cleanup
    && w.holdDeadlineMs === w.cleanupDeadlineMs + tail, 'Invalid finite owner window');
  check(o.state !== 'RELEASED' || reference(o.evidence.terminal), 'RELEASED requires immutable terminal evidence');
  return o;
}

export async function assertAdmissionPredecessor(owner, options = {}) {
  check(only(options, ['store']), 'Legacy bootstrap/evidence override is not an initialization capability');
  const { store = ownerStore() } = options;
  const o = owner === null ? null : parseGateOwner(owner, { boundary: store.boundary });
  if (o) check(o.state === 'RELEASED', 'Prior CI/formal owner is unresolved');
  await store.initialization(o);
  if (o === null) return; // only an explicitly initialized, never-consumed root
  const receipt = await store.readEvidence(o.evidence.terminal);
  check(receipt.version === 2 && receipt.epoch === o.epoch && receipt.runId === o.runId && receipt.purpose === o.purpose
    && receipt.writers === 'STOPPED' && receipt.cleanup === 'SETTLED' && receipt.lifecycle === 'SETTLED'
    && receipt.holder?.heldAtCommit === true && receipt.holder.releaseIntended === true,
  'Terminal lifecycle is not settled');
}

async function atomicJSON(path, value) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const ref = await immutableJSON(temporary, value);
    await rename(temporary, path);
    const dir = await open(dirname(path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return { path, sha256: ref.sha256 };
  } finally { await rm(temporary, { force: true }); }
}

// The pre-existing injected filesystem-store seam is for OWN fixtures only.
// Production callers use ownerStore(); no CLI/allocation can override its path.
// Even fixtures serialize the fixed logical durable paths, mapped privately here.
export function ownerStore(path = GATE_OWNER_PATH, { boundary = GATE_BOUNDARY } = {}) {
  const gate = gateBoundary(boundary);
  const root = dirname(resolve(path));
  const initialPath = resolve(root, 'initialization.json');
  const consumptionPath = resolve(root, 'first-consumption.json');
  const local = logical => {
    check(typeof logical === 'string' && (logical === gate.authorityPath || logical === `${gate.root}/first-consumption.json`
      || full(`${gate.root}/receipts/[a-f0-9]{32}/(?:admission|lifecycle|terminal|unlock)\\.json`, logical)), 'Reference outside fixed durable state');
    return resolve(root, logical.slice(gate.root.length + 1));
  };
  const ensureRoot = async () => { check(await realpath(root) === root, 'Durable root is missing or redirected; reconciliation required'); };
  const optionalJSON = async file => { try { return await readJSON(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const store = {
    async read() { await ensureRoot(); return optionalJSON(path); },
    async write(value) { await ensureRoot(); await atomicJSON(path, value); },
    async readEvidence(ref) {
      await ensureRoot(); check(reference(ref), 'Invalid durable evidence reference');
      return readReference({ ...ref, path: local(ref.path) });
    },
    async evidence(epoch, kind, value) {
      check(hex(epoch, 32) && ['admission', 'lifecycle', 'terminal', 'unlock'].includes(kind), 'Invalid durable evidence identity');
      await ensureRoot();
      const logical = `${gate.root}/receipts/${epoch}/${kind}.json`, target = local(logical);
      // Only the explicit initializer creates receipts/. Missing state is not repaired.
      try { await mkdir(dirname(target), { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      check(await realpath(dirname(target)) === dirname(target), 'Receipt directory redirected');
      const ref = await immutableJSON(target, value);
      return { ...ref, path: logical };
    },
    async initialize({ initializationId, parentDecisionSha256 }, assertHeld) {
      check(hex(initializationId, 32) && hex(parentDecisionSha256, 64), 'Explicit parent initialization identity required');
      await assertHeld();
      await mkdir(dirname(root), { recursive: true, mode: 0o700 });
      check(await realpath(dirname(root)) === dirname(root), 'Initialization parent redirected');
      await mkdir(root, { mode: 0o700 }); // EXCLUSIVE: partial/existing root is never reset
      await ensureRoot();
      const authority = { version: 2, initializationId, service: gate.service, host: gate.host, port: gate.port,
        namespaces: { ci: gate.namespaces.ci, formal: gate.namespaces.formal }, budgetsMs: BUDGETS, parentDecisionSha256, initializedAt: utcNow() };
      const saved = await immutableJSON(resolve(root, 'authority.json'), authority);
      await mkdir(resolve(root, 'receipts'), { mode: 0o700 });
      const authorityRef = { path: gate.authorityPath, sha256: saved.sha256 };
      const initial = { version: 2, initializationId, state: 'UNUSED', authorityRef };
      await assertHeld();
      await immutableJSON(initialPath, initial); // written last; partial setup stays unusable
      const parent = await open(dirname(root), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      return initial;
    },
    async initialization(owner) {
      await ensureRoot();
      const initial = await readJSON(initialPath); // ENOENT never means unused
      check(only(initial, ['version', 'initializationId', 'state', 'authorityRef', 'consumptionRef'])
        && initial.version === 2 && hex(initial.initializationId, 32) && ['UNUSED', 'CONSUMED'].includes(initial.state)
        && reference(initial.authorityRef) && initial.authorityRef.path === gate.authorityPath, 'Invalid durable initialization; reconciliation required');
      const authority = await store.readEvidence(initial.authorityRef);
      check(only(authority, ['version', 'initializationId', 'service', 'host', 'port', 'namespaces', 'budgetsMs', 'parentDecisionSha256', 'initializedAt'])
        && authority.version === 2 && authority.initializationId === initial.initializationId && authority.service === gate.service
        && authority.host === gate.host && authority.port === gate.port && hex(authority.parentDecisionSha256, 64)
        && JSON.stringify(authority.namespaces) === JSON.stringify(gate.namespaces)
        && JSON.stringify(authority.budgetsMs) === JSON.stringify(BUDGETS), 'Durable authority mismatch');
      const consumption = await optionalJSON(consumptionPath);
      if (initial.state === 'UNUSED') {
        check(!Object.hasOwn(initial, 'consumptionRef') && consumption === null, 'Partial consumption; reconciliation required');
        check(owner === undefined || owner === null, 'Owner exists without consumed initialization');
      } else {
        check(reference(initial.consumptionRef) && initial.consumptionRef.path === `${gate.root}/first-consumption.json` && consumption,
          'Consumed initialization lost required receipt; reconciliation required');
        const first = await store.readEvidence(initial.consumptionRef);
        check(only(first, ['version', 'initializationId', 'epoch', 'purpose', 'runId', 'authorityRef']) && first.version === 2
          && first.initializationId === initial.initializationId && hex(first.epoch, 32) && ['ci', 'formal'].includes(first.purpose)
          && full('[A-Za-z0-9_-]{1,128}', first.runId) && JSON.stringify(first.authorityRef) === JSON.stringify(initial.authorityRef), 'Invalid first consumption receipt');
        check(owner !== null, 'Consumed canonical owner is missing; reconciliation required');
      }
      if (owner) {
        const o = parseGateOwner(owner, { boundary: gate });
        check(o.initializationId === initial.initializationId && JSON.stringify(o.authorityRef) === JSON.stringify(initial.authorityRef), 'Owner initialization binding mismatch');
        const admission = await store.readEvidence(o.evidence.admission);
        check(admission.version === 2 && admission.epoch === o.epoch && admission.runId === o.runId && admission.purpose === o.purpose, 'Durable admission identity mismatch');
      }
      return initial;
    },
    async consume(owner) {
      const initial = await store.initialization(null);
      check(owner.initializationId === initial.initializationId && JSON.stringify(owner.authorityRef) === JSON.stringify(initial.authorityRef), 'Initial publication is not authorized');
      const first = { version: 2, initializationId: initial.initializationId, epoch: owner.epoch,
        purpose: owner.purpose, runId: owner.runId, authorityRef: initial.authorityRef };
      const ref = await immutableJSON(consumptionPath, first); // durable one-shot, before ACTIVE
      const consumed = { ...initial, state: 'CONSUMED', consumptionRef: { ...ref, path: `${gate.root}/first-consumption.json` } };
      await atomicJSON(initialPath, consumed); // lost/partial either file cannot become UNUSED
      return consumed;
    },
  };
  Object.defineProperty(store, 'boundary', { value: gate });
  return store;
}

// Explicit operator action, never called by ordinary CI admission. No migration,
// overwrite, missing-state recovery or bootstrap boolean is supported.
export function initializeGate(input, heldLock, { store = ownerStore() } = {}) {
  return underHolder(heldLock, async () => store.initialize(input, () => heldLock.assertHeld()));
}

const publications = new WeakMap();
function underHolder(heldLock, action) {
  const lane = publications.get(heldLock) ?? { pending: new Set(), tail: Promise.resolve() };
  publications.set(heldLock, lane);
  const operation = lane.tail.then(action);
  lane.tail = operation.then(() => {}, () => {});
  lane.pending.add(operation);
  operation.then(() => lane.pending.delete(operation), () => lane.pending.delete(operation));
  return operation;
}

export function publishOwnerTransition(expected, next, heldLock, options = {}) {
  return underHolder(heldLock, () => guardedOwnerTransition(expected, next, heldLock, options));
}

async function guardedOwnerTransition(expected, next, heldLock, options) {
  check(only(options, ['store']), 'Legacy bootstrap/evidence override is not an initialization capability');
  const { store = ownerStore() } = options;
  await heldLock.assertHeld();
  const before = await store.read();
  check(expected === null ? before === null : before?.epoch === expected.epoch && before?.revision === expected.revision,
    'Stale canonical owner transition');
  const after = parseGateOwner(next, { boundary: store.boundary });
  if (!before || before.epoch !== after.epoch) {
    await assertAdmissionPredecessor(before, { store });
    check(after.state === 'ACTIVE' && after.revision === 1, 'New epoch must begin ACTIVE');
  } else {
    const old = parseGateOwner(before, { boundary: store.boundary });
    const allowed = { ACTIVE: ['QUIESCING', 'UNRESOLVED'], QUIESCING: ['CLEANING', 'UNRESOLVED'], CLEANING: ['RELEASED', 'UNRESOLVED'] };
    check(allowed[old.state]?.includes(after.state) && after.revision === old.revision + 1, 'Invalid owner transition');
    check(JSON.stringify(old.evidence.admission) === JSON.stringify(after.evidence.admission), 'Admission evidence changed within epoch');
    for (const field of ['initializationId', 'purpose', 'runId', 'authorityRef', 'instance', 'namespace', 'holder', 'window']) {
      check(JSON.stringify(old[field]) === JSON.stringify(after[field]), 'Owner binding changed within epoch');
    }
  }
  const initial = await store.initialization(before);
  check(after.initializationId === initial.initializationId && JSON.stringify(after.authorityRef) === JSON.stringify(initial.authorityRef), 'Publication initialization binding mismatch');
  const admission = await store.readEvidence(after.evidence.admission);
  check(admission.version === 2 && admission.epoch === after.epoch && admission.runId === after.runId && admission.purpose === after.purpose, 'Durable admission identity mismatch');
  if (after.state === 'RELEASED') await assertAdmissionPredecessor(after, { store });
  await heldLock.assertHeld();
  if (before === null) await store.consume(after);
  await heldLock.assertHeld();
  await store.write(after);
  return after;
}

// An allocation must match exactly one declared lane (service, route, db,
// durable owner/authority paths and lock); a third boundary is not
// introducible through allocation input.
export function allocationBoundary(allocation) {
  const gate = GATE_BOUNDARIES.find(lane => allocation.service === lane.service && allocation.host === lane.host
    && allocation.port === lane.port && allocation.db === lane.namespaces.ci
    && allocation.ownerPath === lane.ownerPath && allocation.lockPath === lane.lockPath
    && allocation.authorityRef?.path === lane.authorityPath);
  check(gate, 'Invalid allocated Redis boundary');
  return gate;
}
export function parseAllocation(raw) {
  const a = parse(raw);
  check(only(a, ['version', 'initializationId', 'purpose', 'mode', 'service', 'host', 'port', 'db', 'ownerPath', 'lockPath', 'containerId', 'serverRunId', 'authorityRef'])
    && a.version === 2 && hex(a.initializationId, 32) && a.purpose === 'ci' && a.mode === 'borrowed-exclusive-db', 'Explicit CI Redis allocation required');
  allocationBoundary(a);
  check(hex(a.containerId, 64) && hex(a.serverRunId, 40) && reference(a.authorityRef), 'Invalid allocation identity');
  check(!Object.keys(a).some(key => /url|password|username|credential/i.test(key)), 'Invalid allocation input');
  return a;
}

// Timeout only bounds observation. It does not undo an operation already sent.
export async function observeWithin(operation, ms, code = 'Operation deadline exceeded') {
  check(Number.isFinite(ms) && ms > 0, code);
  let timer;
  try { return await Promise.race([Promise.resolve(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}

export const CONTROL_OPTIONS = Object.freeze({
  lazyConnect: true, enableOfflineQueue: false, retryStrategy: null, reconnectOnError: null,
  autoResendUnfulfilledCommands: false, autoResubscribe: false, enableAutoPipelining: false,
  maxRetriesPerRequest: 0, enableReadyCheck: false, disableClientInfo: true,
  connectTimeout: 2000, commandTimeout: 2000, disconnectTimeout: 100,
});
export function installedRedis() { return createRequire(import.meta.url)('ioredis'); }

export class ControlRedis {
  constructor({ Redis, authority, deadline, clock = monotonicMs, options = {}, timeoutMs = 2000, boundary = GATE_BOUNDARY }) {
    const gate = gateBoundary(boundary);
    this.authority = authority; this.deadline = deadline; this.clock = clock; this.timeoutMs = timeoutMs;
    this.boundary = gate; this.db = gate.namespaces.ci;
    this.operations = []; this.pending = null; this.invalid = false; this.effectUnknown = false; this.closing = false;
    check(Object.keys(options).every(key => key === 'Connector'), 'Control options cannot override allocated route');
    this.client = new Redis({ host: gate.host, port: gate.port, db: gate.namespaces.ci, ...options, ...CONTROL_OPTIONS,
      commandTimeout: timeoutMs, connectTimeout: timeoutMs });
    this.client.on('error', () => this.invalidate('transport-error'));
    this.client.on('close', () => { if (!this.closing) this.invalidate('transport-close'); });
  }
  async guard() {
    try {
      check(!this.invalid && !this.closing && this.clock() < this.deadline, 'Redis control authority unavailable');
      await this.authority();
      check(!this.invalid && !this.closing && this.clock() < this.deadline, 'Redis control authority expired');
    } catch { this.invalidate('authority-invalidated'); throw new Error('Redis control authority unavailable'); }
  }
  invalidate(reason) {
    this.invalid = true; this.reason ??= reason;
    if (this.pending) {
      this.pending.outcome = 'UNKNOWN';
      if (this.pending.mutation) this.effectUnknown = true;
    }
    this.client.disconnect(false);
    this.client.stream?.destroy();
  }
  async connect() {
    await this.guard();
    try {
      await observeWithin(this.client.connect(), Math.min(this.timeoutMs, this.deadline - this.clock()), 'Redis connect unknown');
      await this.guard();
      check(this.client.status === 'ready', 'Redis control is not ready');
      // ioredis ready can precede its automatic SELECT acknowledgement. Never
      // permit a data command until an explicit SELECT<ci-db> ACK has been observed.
      await observeWithin(this.client.call('select', this.db), Math.min(this.timeoutMs, this.deadline - this.clock()), 'Redis SELECT unknown');
      await this.guard();
    } catch { this.invalidate('connect-failed'); throw new Error('Redis control connection failed'); }
  }
  async command(name, ...args) {
    await this.guard();
    check(this.client.status === 'ready' && !this.pending, 'Redis control cannot submit');
    check(['ping', 'info', 'config', 'client', 'pubsub', 'dbsize', 'scan', 'del', 'set', 'exists'].includes(name), 'Forbidden Redis control command');
    const remaining = Math.min(this.timeoutMs, this.deadline - this.clock());
    check(remaining > 0, 'Redis control budget exhausted before submission');
    const op = { name, mutation: ['del', 'set'].includes(name), outcome: 'ISSUED',
      ...(['del', 'set'].includes(name) ? { keys: (name === 'del' ? args : args.slice(0, 1)).map(String) } : {}) };
    this.operations.push(op); this.pending = op;
    try {
      const reply = await observeWithin(this.client.call(name, ...args), remaining, 'Redis command unknown');
      await this.guard();
      op.outcome = 'ACK';
      return reply;
    } catch {
      this.invalidate('command-failed-or-authority-lost');
      throw new Error('Redis control operation UNKNOWN; no automatic retry');
    } finally { this.pending = null; }
  }
  async close() {
    if (this.pending) this.invalidate('close-with-pending-command');
    this.closing = true;
    const ended = this.client.status === 'end' ? Promise.resolve() : new Promise(done => this.client.once('end', done));
    this.client.disconnect(false); this.client.stream?.destroy();
    try { await observeWithin(ended, Math.min(this.timeoutMs, 2000), 'Redis close unconfirmed'); return { status: 'CLOSED', effectUnknown: this.effectUnknown }; }
    catch { this.invalid = true; return { status: 'UNKNOWN', effectUnknown: this.effectUnknown }; }
  }
}

export async function processIdentity(pid = process.pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid, startTicks: fields[19], state: fields[0], bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
}

// The parent and guardian share the same open-file description. Losing the
// guardian cannot release flock while a parent publication is still in flight.
// The guardian has a hard deadline and terminates only its identity-pinned parent
// before closing the final lock fd. No stale publisher can overwrite a successor.
const holderSource = `
  const fs = require('node:fs'), {spawnSync} = require('node:child_process');
  const end = Number(process.argv[1]), parent = JSON.parse(process.argv[2]);
  const now = () => Number(process.hrtime.bigint()/1000000n);
  function parentAlive() {
    try { const s=fs.readFileSync('/proc/'+parent.pid+'/stat','utf8');
      const f=s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/);
      return f[19]===parent.startTicks && !['Z','X'].includes(f[0]);
    } catch {return false}
  }
  if (!(end>now()) || spawnSync('/usr/bin/flock',['-n','3'],{stdio:['ignore','ignore','ignore',3]}).status!==0) process.exit(75);
  const term=setTimeout(()=>{if(parentAlive())process.kill(parent.pid,'SIGTERM')},Math.max(1,end-now()-1000));
  const stop=setTimeout(()=>{if(parentAlive())process.kill(parent.pid,'SIGKILL');process.exit(75)},Math.max(1,end-now()));
  let input='';process.stdin.on('data',b=>{input+=b;if(input==='RELEASE\\n'){clearTimeout(term);clearTimeout(stop);process.exit(0)}});
  process.stdin.once('end',()=>{if(!parentAlive())process.exit(75)});
  process.stdout.write('LOCKED\\n');
`;
export async function acquireLock({ path = GATE_LOCK_PATH, node = process.execPath, deadline = monotonicMs() + 1_950_000, onLost = () => {} } = {}) {
  const now = monotonicMs();
  check(integer(deadline) && deadline > now && deadline - now <= 3_900_000, 'Invalid finite holder window');
  const identity = await processIdentity();
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  const child = spawn(node, ['-e', holderSource, String(deadline), JSON.stringify(identity)], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe', file.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  let closed = false, expected = false, fileClosed = false, failure, guardian;
  child.stdin.on('error', () => {}); child.stderr.resume();
  const settled = new Promise(done => {
    child.once('error', () => { failure = 'holder-spawn'; closed = true; done({ status: 'UNKNOWN' }); });
    child.once('close', (code, signal) => {
      closed = true;
      if (!expected) { failure = 'holder-lost'; onLost(); }
      done({ status: expected && code === 0 && signal === null ? 'UNLOCKED' : 'UNKNOWN', code, signal, expected });
    });
  });
  const closeFile = async () => { if (!fileClosed) { fileClosed = true; await file.close(); } };
  try {
    await observeWithin(new Promise((done, reject) => {
      let text = '';
      child.stdout.on('data', chunk => { text += chunk; if (text === 'LOCKED\n') done(); else if (text.length > 32) reject(new Error('Invalid holder handshake')); });
      child.once('close', () => reject(new Error('Gate lock unavailable')));
      child.once('error', () => reject(new Error('Gate lock unavailable')));
    }), 2000, 'Gate lock acquisition expired');
    guardian = await processIdentity(child.pid);
  } catch (error) { expected = true; await closeFile(); child.kill('SIGKILL'); await settled; throw error; }
  const token = {
    identity: { ...identity, guardianPid: guardian.pid, guardianStartTicks: guardian.startTicks }, deadline,
    async assertHeld() {
      check(!closed && !expected && !fileClosed && !failure && monotonicMs() < deadline, 'Gate holder unavailable');
      const actual = await processIdentity(child.pid);
      check(!closed && !expected && !fileClosed && monotonicMs() < deadline
        && actual.startTicks === guardian.startTicks && actual.bootId === guardian.bootId && !['Z', 'X'].includes(actual.state), 'Gate guardian identity changed');
    },
    async release() {
      expected = true;
      // An observation timeout does not cancel fsync/rename. Keep both lock
      // descriptors pinned if a submitted publication is still unsettled. The
      // finite guardian then kills the identity-pinned publisher before unlock.
      const pending = [...(publications.get(token)?.pending ?? [])];
      if (pending.length) {
        try { await observeWithin(Promise.allSettled(pending), Math.max(1, Math.min(2000, deadline - monotonicMs()))); }
        catch { return { status: 'UNKNOWN', pendingPublication: true }; }
      }
      await closeFile(); // no further publication can pass assertHeld
      child.stdin.end('RELEASE\n');
      try { return await observeWithin(settled, 2000, 'Gate unlock unconfirmed'); }
      catch { child.kill('SIGKILL'); await settled; return { status: 'UNKNOWN', expected: true }; }
    },
  };
  return token;
}

export async function inspectGate(expected, { boundary = GATE_BOUNDARY, exec = promisify(execFile) } = {}) {
  const gate = gateBoundary(boundary);
  const format = '{"id":{{json .Id}},"running":{{json .State.Running}},"ports":{{json (index .NetworkSettings.Ports "6379/tcp")}}}';
  const { stdout } = await exec('/usr/bin/docker', ['inspect', '--format', format, expected.containerId], {
    timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 4096, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  const found = JSON.parse(stdout);
  check(found.id === expected.containerId && found.running === true && found.ports?.length === 1
    && found.ports[0].HostIp === gate.host && found.ports[0].HostPort === String(gate.port), 'Gate container identity/mapping changed');
  return { containerId: found.id, running: true, host: gate.host, port: gate.port };
}

// Fixture-key whitelist: the exact key shapes the adopting repo's test suite
// writes into the borrowed DB. collectFixtureKeys refuses to release (delete)
// anything not matching this whitelist — fail-closed by construction. When you
// adopt this kit, replace the pattern below with the key shapes YOUR tests
// write; keep it strict. (The slice(18) offsets below are tied to the literal
// prefix lengths — adjust them together if you change the prefixes.)
const mailboxPattern = '(?:job-(?:lease|request|independent-box|box-owner-loss|box-release|shared-box|keepalive-replaced|keepalive-race|keepalive)-[0-9]+|job-keepalive-scheduler-[0-9]+(?:-other)?|manual-(?:shared|target|invalid|cas)-[0-9]+|job-scheduler-[0-9]+-[ab]|lane-(?:runtime|control|health|sparse)-[0-9]+|ci-redis-probe-[a-f0-9]{32})';
export function expectedFixtureKey(key) {
  if (typeof key !== 'string' || Buffer.byteLength(key) > 4096) return false;
  if (key.startsWith('demo:sync-request:')) {
    return full(mailboxPattern, key.slice(18)) || full('demo-lua-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', key.slice(18));
  }
  if (!key.startsWith('demo:sync-lock:v2:')) return false;
  const rest = key.slice(18), colon = rest.indexOf(':');
  if (colon < 0 || !full(mailboxPattern, rest.slice(0, colon))) return false;
  const segment = rest.slice(colon + 1);
  try { return encodeURIComponent(decodeURIComponent(segment)) === segment; } catch { return false; }
}

export async function collectFixtureKeys(control, { maxPages = 1000, maxKeys = 4096, maxBytes = 1_048_576, scanBudget = { remaining: 1000 } } = {}) {
  const keys = new Set(); let cursor = '0', bytes = 0;
  for (let page = 0; page < maxPages; page++) {
    check(scanBudget.remaining-- > 0, 'Redis release scan budget exceeded');
    const reply = await control.command('scan', cursor, 'COUNT', '200');
    check(Array.isArray(reply) && reply.length === 2 && full('[0-9]+', reply[0]) && Array.isArray(reply[1]), 'Invalid Redis inventory');
    cursor = reply[0];
    check(reply[1].length <= maxKeys, 'Redis inventory page exceeds limit');
    for (const key of reply[1]) {
      check(expectedFixtureKey(key), 'Unexpected key in exclusive DB; no deletion authorized');
      if (!keys.has(key)) { bytes += Buffer.byteLength(key); keys.add(key); }
      check(keys.size <= maxKeys && bytes <= maxBytes, 'Redis inventory exceeds limit');
    }
    if (cursor === '0') return [...keys].sort();
  }
  throw new Error('Redis inventory incomplete at page limit');
}

// Also usable on a small explicitly owned fixture; no owner transition or unlock.
export async function deleteExactKeys(control, keys, recordIntent = async () => {}, beforeBatch = async () => {}, recordBatch = async () => {}) {
  check(Array.isArray(keys) && keys.length <= 4096 && keys.every(expectedFixtureKey) && new Set(keys).size === keys.length, 'Invalid exact cleanup keys');
  await recordIntent(keys);
  const batches = [];
  for (let i = 0; i < keys.length; i += 64) {
    const batch = keys.slice(i, i + 64);
    await beforeBatch();
    const deleted = await control.command('del', ...batch);
    check(integer(deleted) && deleted <= batch.length, 'Invalid delete acknowledgement');
    const receipt = { keys: batch, deleted, outcome: 'ACK' };
    await recordBatch(receipt, batches.length);
    batches.push(receipt);
  }
  return { observed: keys.length, batches };
}

export async function verifyRedisOccupancy(control, serverRunId) {
  check(await control.command('ping') === 'PONG', 'Gate is not ready');
  const server = await control.command('info', 'server');
  check(typeof server === 'string' && server.split(/\r?\n/).includes(`run_id:${serverRunId}`), 'Redis server generation changed');
  const id = String(await control.command('client', 'ID'));
  const list = await control.command('client', 'LIST');
  const clients = list.trim().split('\n').filter(Boolean).map(line => Object.fromEntries(line.trim().split(' ').map(field => field.split('='))));
  check(clients.length === 1 && clients[0].id === id && clients[0].db === String(control.db), 'Unexplained gate Redis consumer');
  check(await control.command('pubsub', 'NUMPAT') === 0 && (await control.command('pubsub', 'CHANNELS')).length === 0, 'Gate has PubSub consumers');
  return { serverRunId, ownClientId: id, clients: 1, subscriptions: 0 };
}

export async function verifyRedisAdmission(control, serverRunId) {
  const occupancy = await verifyRedisOccupancy(control, serverRunId);
  const config = await control.command('config', 'GET', 'databases');
  check(Array.isArray(config) && config[0] === 'databases' && Number(config[1]) >= 16, 'Allocated Redis DB unavailable');
  check(await control.command('dbsize') === 0, 'Allocated DB contains unowned data');
  return occupancy;
}

// Each caller awaits every safe independent finalizer even after a predecessor
// fails. Sanitize errors here; never serialize driver commands/credential fields.
export async function recordCleanup(result, name, operation) {
  result.cleanup ??= {};
  try { return result.cleanup[name] = await operation(); }
  catch { result.passed = false; return result.cleanup[name] = { status: 'UNKNOWN', error: `${name} did not settle` }; }
}

export function borrowedResult(allocation) {
  return { mode: 'borrowed-exclusive-db', admission: 'NOT_ADMITTED', service: {
    ownership: 'borrowed', containerId: allocation.containerId, host: allocation.host, port: allocation.port,
  }, db: allocation.db, ownerPath: allocation.ownerPath };
}

// Pure owner-envelope construction for a first admission (ACTIVE, revision 1).
// Every boundary-carrying field is taken from the inputs so lane wiring is
// observable and testable; nothing here consults module constants.
export function ownerEnvelope({ boundary, allocation, identity, epoch, runId, anchorMs, evidence }) {
  const holder = { ...identity, lockPath: boundary.lockPath };
  return { version: 2, initializationId: allocation.initializationId, epoch, revision: 1, purpose: 'ci', state: 'ACTIVE', runId,
    authorityRef: allocation.authorityRef,
    instance: { containerId: allocation.containerId, serverRunId: allocation.serverRunId, host: boundary.host, port: boundary.port },
    namespace: { redisDb: boundary.namespaces.ci, exclusive: true }, holder,
    window: { clock: 'linux-monotonic-ms', bootId: holder.bootId, admittedAt: utcNow(), anchorMs,
      workDeadlineMs: anchorMs + 1_800_000, cleanupDeadlineMs: anchorMs + 1_920_000, holdDeadlineMs: anchorMs + 1_950_000 },
    evidence: { admission: evidence } };
}

export class BorrowedRedis {
  constructor({ allocation, directory, repo, runId, source, onLost = () => {} }) {
    this.allocation = parseAllocation(allocation); this.directory = directory; this.repo = repo; this.runId = runId;
    this.source = source; this.onLost = onLost;
    this.boundary = allocationBoundary(this.allocation);
    this.store = ownerStore(this.boundary.ownerPath, { boundary: this.boundary });
    this.result = borrowedResult(this.allocation);
    this.epoch = randomBytes(16).toString('hex'); this.controls = new Set(); this.lost = false; this.owner = null;
  }
  lose() {
    this.lost = true;
    for (const control of this.controls) control.invalidate('holder-lost');
    this.onLost();
  }
  async authority() {
    check(!this.lost, 'Borrowed Redis authority lost');
    await this.holder.assertHeld();
    await this.store.initialization(this.owner ?? undefined);
    if (this.owner) {
      const actual = await this.store.read();
      check(actual?.epoch === this.owner.epoch && actual.revision === this.owner.revision
        && ['ACTIVE', 'QUIESCING', 'CLEANING'].includes(actual.state), 'Borrowed Redis epoch changed');
    }
  }
  async control(deadline) {
    const c = new ControlRedis({ Redis: installedRedis(), authority: () => this.authority(), deadline, boundary: this.boundary });
    this.controls.add(c); await c.connect(); return c;
  }
  async acquire() {
    const initialized = await this.store.initialization();
    check(initialized.initializationId === this.allocation.initializationId
      && JSON.stringify(initialized.authorityRef) === JSON.stringify(this.allocation.authorityRef), 'Allocation does not match durable initialization');
    await immutableJSON(resolve(this.directory, 'redis-attempt.json'), { version: 2, state: 'APPROVED_NOT_ACQUIRED', epoch: this.epoch, runId: this.runId, source: this.source, allocation: this.allocation });
    // Anchor before flock/identity checks: admission cannot renew preflight time.
    const anchorMs = monotonicMs();
    this.holder = await acquireLock({ path: this.boundary.lockPath, deadline: anchorMs + 1_950_000, onLost: () => this.lose() });
    const previous = await this.store.read();
    await assertAdmissionPredecessor(previous, { store: this.store });
    await inspectGate(this.allocation, { boundary: this.boundary });
    const c = await this.control(Math.min(anchorMs + 10_000, this.holder.deadline));
    let admission;
    try {
      admission = await verifyRedisAdmission(c, this.allocation.serverRunId);
    } finally { const closed = await c.close(); check(closed.status === 'CLOSED' && !closed.effectUnknown, 'Admission control close unknown'); }
    const evidence = await this.store.evidence(this.epoch, 'admission', { version: 2, epoch: this.epoch, runId: this.runId, purpose: 'ci', source: this.source, admission });
    await this.authority();
    const next = ownerEnvelope({ boundary: this.boundary, allocation: this.allocation, identity: this.holder.identity,
      epoch: this.epoch, runId: this.runId, anchorMs, evidence });
    // Keep intent even if publication commits and its fsync response is lost.
    this.activationAttempted = true; this.owner = next;
    await publishOwnerTransition(previous && { epoch: previous.epoch, revision: previous.revision }, next, this.holder, { store: this.store });
    this.result.admission = 'ACTIVE'; this.result.epoch = this.epoch; this.result.evidence = evidence;
    this.workTimer = setTimeout(() => { this.onLost(); }, Math.max(1, next.window.workDeadlineMs - monotonicMs()));
    return `redis://${this.boundary.host}:${this.boundary.port}/${this.boundary.namespaces.ci}`;
  }
  async transition(state, evidence) {
    await this.authority();
    const next = { ...this.owner, revision: this.owner.revision + 1, state,
      evidence: { ...this.owner.evidence, ...evidence } };
    this.owner = await publishOwnerTransition({ epoch: this.owner.epoch, revision: this.owner.revision }, next, this.holder, { store: this.store });
  }
  async cleanupRedis(writers, deadline) {
    clearTimeout(this.workTimer);
    check(this.result.admission === 'ACTIVE', 'Redis was not admitted');
    check(writers.status === 'STOPPED' && !writers.ambiguousEffects, 'Redis writer/effect cessation UNKNOWN');
    await this.transition('QUIESCING');
    await inspectGate(this.allocation, { boundary: this.boundary });
    const c = await this.control(Math.min(deadline, monotonicMs() + 30_000));
    try {
      await verifyRedisOccupancy(c, this.allocation.serverRunId);
      await this.transition('CLEANING');
      const scanBudget = { remaining: 1000 };
      const keys = await collectFixtureKeys(c, { scanBudget });
      const result = await deleteExactKeys(c, keys,
        exact => immutableJSON(resolve(this.directory, 'redis-delete-intent.json'), { version: 1, epoch: this.epoch, keys: exact }),
        () => verifyRedisOccupancy(c, this.allocation.serverRunId),
        (batch, index) => immutableJSON(resolve(this.directory, `redis-delete-batch-${index}.json`), { version: 1, epoch: this.epoch, ...batch }));
      check((await collectFixtureKeys(c, { scanBudget })).length === 0 && await c.command('dbsize') === 0, 'Redis cleanup not empty');
      await verifyRedisOccupancy(c, this.allocation.serverRunId);
      await inspectGate(this.allocation, { boundary: this.boundary });
      return { status: 'SETTLED', ...result, instanceUnchanged: true };
    } finally {
      const closed = await c.close();
      this.result.controlOperations = structuredClone(c.operations);
      this.result.controlEvidence = await immutableJSON(resolve(this.directory, 'redis-control.json'), { version: 1, epoch: this.epoch, ...closed, operations: c.operations });
      check(closed.status === 'CLOSED' && !closed.effectUnknown, 'Redis cleanup control UNKNOWN');
    }
  }
  async settle({ writers, redis, postgres, lifecycle }) {
    clearTimeout(this.workTimer);
    if (!this.owner) return { status: 'NOT_ADMITTED' };
    let held = false;
    try { await this.authority(); held = true; } catch { /* do not fabricate held-at-commit */ }
    const settled = held && this.owner.state === 'CLEANING' && writers.status === 'STOPPED' && !writers.ambiguousEffects && redis.status === 'SETTLED'
      && postgres.status === 'SETTLED' && lifecycle === 'SETTLED' && !this.lost;
    const receipt = await this.store.evidence(this.epoch, 'terminal', {
      version: 2, epoch: this.epoch, runId: this.runId, purpose: 'ci', writers: settled ? 'STOPPED' : 'UNKNOWN',
      cleanup: settled ? 'SETTLED' : 'UNKNOWN', lifecycle: settled ? 'SETTLED' : 'UNKNOWN',
      holder: { heldAtCommit: held, releaseIntended: true }, components: { writers, redis, postgres },
    });
    try {
      await this.transition(settled ? 'RELEASED' : 'UNRESOLVED', { terminal: receipt });
      return { status: settled ? 'RELEASED' : 'UNRESOLVED', evidence: receipt };
    } catch { return { status: 'UNRESOLVED', evidence: receipt, publication: 'UNKNOWN' }; }
  }
  async unlock() {
    clearTimeout(this.workTimer);
    const controls = [];
    for (const c of this.controls) {
      try { controls.push(await c.close()); } catch { controls.push({ status: 'UNKNOWN' }); }
    }
    let outcome;
    try { outcome = this.holder ? await this.holder.release() : { status: 'NOT_ACQUIRED' }; }
    catch { outcome = { status: 'UNKNOWN' }; }
    const receipt = { version: 2, epoch: this.epoch, ...outcome, controls };
    if (this.activationAttempted) await this.store.evidence(this.epoch, 'unlock', receipt);
    else await immutableJSON(resolve(this.directory, 'redis-unlock-not-admitted.json'), receipt);
    return { ...outcome, controls };
  }
}
