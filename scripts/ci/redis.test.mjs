import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { BUDGETS, GATE_ROOT, GATE_AUTHORITY_PATH, GATE_LOCK_PATH, GATE_OWNER_PATH, GATE_BOUNDARY, GATE_BOUNDARIES,
  gateBoundary, allocationBoundary, CONTROL_OPTIONS, ControlRedis, BorrowedRedis,
  parseAllocation, parseGateOwner, assertAdmissionPredecessor, publishOwnerTransition, ownerStore, initializeGate,
  immutableJSON, readJSON, acquireLock, monotonicMs, processIdentity, observeWithin, installedRedis, ownerEnvelope,
  expectedFixtureKey, collectFixtureKeys, deleteExactKeys, borrowedResult, inspectGate,
  verifyRedisAdmission, recordCleanup } from './redis.mjs';

const repo = process.env.AGENT_CI_TEST_REPO ?? fileURLToPath(new URL('../..', import.meta.url));
const initializationId = 'd'.repeat(32), ref = { path: GATE_AUTHORITY_PATH, sha256: 'a'.repeat(64) };
const allocation = (boundary = GATE_BOUNDARY) => ({ version: 2, initializationId, purpose: 'ci', mode: 'borrowed-exclusive-db', service: boundary.service,
  host: boundary.host, port: boundary.port, db: boundary.namespaces.ci, ownerPath: boundary.ownerPath, lockPath: boundary.lockPath,
  containerId: 'b'.repeat(64), serverRunId: 'c'.repeat(40), authorityRef: { path: boundary.authorityPath, sha256: 'a'.repeat(64) } });
function envelope(purpose = 'ci', state = 'ACTIVE', boundary = GATE_BOUNDARY) {
  const [work, cleanup, tail] = BUDGETS[purpose], epoch = randomBytes(16).toString('hex');
  const bootId = '11111111-1111-1111-1111-111111111111';
  const evidence = kind => ({ path: boundary.root + '/receipts/' + epoch + '/' + kind + '.json', sha256: 'a'.repeat(64) });
  return { version: 2, initializationId, epoch, revision: 1, purpose, state,
    runId: 'pure-fixture', authorityRef: { path: boundary.authorityPath, sha256: 'a'.repeat(64) },
    instance: { containerId: 'b'.repeat(64), serverRunId: 'c'.repeat(40), host: boundary.host, port: boundary.port },
    namespace: { redisDb: boundary.namespaces[purpose], exclusive: true },
    holder: { pid: 123, startTicks: '42', bootId, lockPath: boundary.lockPath },
    window: { clock: 'linux-monotonic-ms', bootId, admittedAt: '2026-10-03T04:00:00.000Z', anchorMs: 1000,
      workDeadlineMs: 1000 + work, cleanupDeadlineMs: 1000 + work + cleanup, holdDeadlineMs: 1000 + work + cleanup + tail },
    evidence: { admission: evidence('admission'), ...(state === 'RELEASED' ? { terminal: evidence('terminal') } : {}) } };
}
const receipt = owner => ({ version: 2, epoch: owner.epoch, runId: owner.runId, purpose: owner.purpose,
  writers: 'STOPPED', cleanup: 'SETTLED', lifecycle: 'SETTLED', holder: { heldAtCommit: true, releaseIntended: true } });
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'agent-ci-redis-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const held = { assertHeld: async () => {} };
async function registry(t, lock = held, boundary = GATE_BOUNDARY) {
  const dir = await fixture(t), root = resolve(dir, 'durable'), path = resolve(root, 'owner.json'), store = ownerStore(path, { boundary });
  const initial = await initializeGate({ initializationId, parentDecisionSha256: 'e'.repeat(64) }, lock, { store });
  return { dir, root, path, store, initial, boundary };
}
async function backed(ctx, purpose = 'ci') {
  const o = envelope(purpose, 'ACTIVE', ctx.boundary); o.authorityRef = ctx.initial.authorityRef;
  o.evidence.admission = await ctx.store.evidence(o.epoch, 'admission', { version: 2, epoch: o.epoch, runId: o.runId, purpose });
  return o;
}
const physical = (ctx, reference) => resolve(ctx.root, reference.path.slice(ctx.boundary.root.length + 1));
async function released(ctx, purpose = 'ci', lock = held) {
  let o = await publishOwnerTransition(null, await backed(ctx, purpose), lock, { store: ctx.store });
  for (const state of ['QUIESCING', 'CLEANING']) o = await publishOwnerTransition(o, { ...o, state, revision: o.revision + 1 }, lock, { store: ctx.store });
  const terminal = await ctx.store.evidence(o.epoch, 'terminal', receipt(o));
  return publishOwnerTransition(o, { ...o, state: 'RELEASED', revision: 4, evidence: { ...o.evidence, terminal } }, lock, { store: ctx.store });
}
const waitFor = async (predicate, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!await predicate()) { assert(Date.now() < deadline, 'bounded fixture wait expired'); await new Promise(done => setTimeout(done, 10)); }
};

test('allocation rejects unassigned DB/routes, credentials, legacy bootstrap and alternate slots', () => {
  assert.equal(parseAllocation(allocation()).db, 13);
  for (const patch of [{ version: 1 }, { bootstrap: true }, { db: 0 }, { db: 15 }, { db: 14 }, { host: 'some-host' }, { port: 6379 }, { purpose: 'formal' },
    { url: 'redis://SECRET@127.0.0.1:16379/13' }, { password: 'SECRET' }, { mode: 'ephemeral' },
    { ownerPath: '/tmp/another-owner.json' }, { lockPath: '/tmp/another-lock' }, { containerId: 'name-not-identity' },
    { authorityRef: { path: { password: 'SECRET' }, sha256: 'a'.repeat(64) } }, { options: { password: 'SECRET' } }]) {
    assert.throws(() => parseAllocation({ ...allocation(), ...patch }), e => !e.message.includes('SECRET'));
  }
  assert.throws(() => parseAllocation('{ SECRET'), e => !e.message.includes('SECRET'));
  assert(!('container' in borrowedResult(allocation())));
  assert.equal(borrowedResult(allocation()).service.ownership, 'borrowed');
  assert.equal(borrowedResult(allocation()).admission, 'NOT_ADMITTED');
});

test('common v2 envelope rejects rebound clocks, namespaces and nondurable required refs', () => {
  for (const purpose of ['ci', 'formal']) {
    const o = envelope(purpose);
    assert.equal(parseGateOwner(o).purpose, purpose);
    assert.equal(o.window.holdDeadlineMs - o.window.anchorMs, purpose === 'ci' ? 1_950_000 : 3_900_000);
    for (const patch of [{ workDeadlineMs: o.window.workDeadlineMs + 1 }, { holdDeadlineMs: o.window.holdDeadlineMs + 1 },
      { clock: 'performance.now' }, { bootId: '22222222-2222-2222-2222-222222222222' }]) assert.throws(() => parseGateOwner({ ...o, window: { ...o.window, ...patch } }));
    assert.throws(() => parseGateOwner({ ...o, namespace: { redisDb: 0, exclusive: true } }));
    assert.throws(() => parseGateOwner({ ...o, evidence: { admission: { ...ref, path: '/tmp/expiring-admission.json' } } }));
    assert.throws(() => parseGateOwner({ ...o, authorityRef: { ...ref, path: '/tmp/expiring-authority.json' } }));
  }
  assert.throws(() => parseGateOwner({ ...envelope(), state: 'APPROVED_NOT_ACQUIRED' }));
  assert.throws(() => parseGateOwner({ ...envelope(), version: 1 }));
});

test('either purpose unfinished blocks both; null needs explicit existing UNUSED initialization', async t => {
  for (const purpose of ['ci', 'formal']) for (const state of ['ACTIVE', 'QUIESCING', 'CLEANING', 'UNRESOLVED']) await assert.rejects(assertAdmissionPredecessor(envelope(purpose, state)), /unresolved/);
  const ctx = await registry(t);
  const absent = ownerStore(resolve(ctx.dir, 'never-initialized', 'owner.json'));
  await assert.rejects(assertAdmissionPredecessor(null, { store: absent }));
  await assert.rejects(assertAdmissionPredecessor(null, { store: ctx.store, bootstrap: true }), /bootstrap/);
  await assertAdmissionPredecessor(null, { store: ctx.store });
  for (const purpose of ['ci', 'formal']) {
    const own = await registry(t), o = await released(own, purpose);
    await assertAdmissionPredecessor(o, { store: own.store });
    const read = own.store.readEvidence;
    for (const patch of [{ cleanup: 'UNKNOWN' }, { writers: 'UNKNOWN' }, { lifecycle: 'UNKNOWN' }, { epoch: 'f'.repeat(32) }]) {
      own.store.readEvidence = async reference => ({ ...await read(reference), ...(reference.path === o.evidence.terminal.path ? patch : {}) });
      await assert.rejects(assertAdmissionPredecessor(o, { store: own.store }));
    }
  }
});

test('R1 lost UNRESOLVED canonical cannot bootstrap a formal owner after durable consumption', async t => {
  const dir = await fixture(t), path = resolve(dir, 'owned.lock'); await writeFile(path, '');
  const lock = await acquireLock({ path, deadline: monotonicMs() + 30_000 });
  try {
    const ctx = await registry(t, lock);
    let o = await publishOwnerTransition(null, await backed(ctx), lock, { store: ctx.store });
    o = await publishOwnerTransition(o, { ...o, state: 'UNRESOLVED', revision: 2 }, lock, { store: ctx.store });
    const formal = await backed(ctx, 'formal');
    await assert.rejects(publishOwnerTransition(o, formal, lock, { store: ctx.store }), /unresolved/);
    await rm(ctx.path);
    assert.equal(await ctx.store.read(), null);
    await assert.rejects(publishOwnerTransition(null, formal, lock, { store: ctx.store }), /missing.*reconciliation/);
    await assert.rejects(publishOwnerTransition(null, formal, lock, { store: ctx.store, bootstrap: true }), /bootstrap/);
    await assert.rejects(initializeGate({ initializationId, parentDecisionSha256: 'e'.repeat(64) }, lock, { store: ctx.store }), { code: 'EEXIST' });
    assert.equal((await ctx.store.initialization()).state, 'CONSUMED');
  } finally { await lock.release(); }
});

test('R1 partial first publication stays consumed; required metadata loss cannot restore UNUSED', async t => {
  const partial = await registry(t), o = await backed(partial);
  const write = partial.store.write;
  partial.store.write = async () => { throw new Error('lost first publication'); };
  await assert.rejects(publishOwnerTransition(null, o, held, { store: partial.store }), /lost first/);
  partial.store.write = write;
  assert.equal((await partial.store.initialization()).state, 'CONSUMED');
  await assert.rejects(publishOwnerTransition(null, await backed(partial, 'formal'), held, { store: partial.store }), /missing/);
  for (const part of ['owner', 'initialization', 'consumption', 'authority', 'admission', 'terminal']) {
    const ctx = await registry(t), owner = await released(ctx);
    const paths = { owner: ctx.path, initialization: resolve(ctx.root, 'initialization.json'), consumption: resolve(ctx.root, 'first-consumption.json'),
      authority: physical(ctx, owner.authorityRef), admission: physical(ctx, owner.evidence.admission), terminal: physical(ctx, owner.evidence.terminal) };
    await rm(paths[part]);
    await assert.rejects(assertAdmissionPredecessor(await ctx.store.read(), { store: ctx.store }));
    await assert.rejects(initializeGate({ initializationId, parentDecisionSha256: 'e'.repeat(64) }, held, { store: ctx.store }), { code: 'EEXIST' });
  }
});

test('partial initialization or consumption is not automatically repaired', async t => {
  const dir = await fixture(t), store = ownerStore(resolve(dir, 'partial', 'owner.json'));
  let checks = 0;
  const lost = { assertHeld: async () => { if (++checks === 2) throw new Error('lost initialization holder'); } };
  await assert.rejects(initializeGate({ initializationId, parentDecisionSha256: 'e'.repeat(64) }, lost, { store }), /lost initialization/);
  await assert.rejects(assertAdmissionPredecessor(null, { store }));
  await assert.rejects(initializeGate({ initializationId, parentDecisionSha256: 'e'.repeat(64) }, held, { store }), { code: 'EEXIST' });
  const ctx = await registry(t), owner = await backed(ctx);
  await immutableJSON(resolve(ctx.root, 'first-consumption.json'), { version: 2, initializationId, epoch: owner.epoch, purpose: owner.purpose, runId: owner.runId, authorityRef: owner.authorityRef });
  await assert.rejects(publishOwnerTransition(null, owner, held, { store: ctx.store }), /Partial consumption/);
  assert.equal((await readJSON(resolve(ctx.root, 'initialization.json'))).state, 'UNUSED');
});

test('trusted holder uses actual flock without ambient preload or PATH replacement', { timeout: 5000 }, async t => {
  const dir = await fixture(t), path = resolve(dir, 'owned.lock'), marker = resolve(dir, 'unsafe-hook');
  await writeFile(path, '');
  const preload = resolve(dir, 'preload.cjs');
  await writeFile(preload, 'require("fs").writeFileSync(' + JSON.stringify(marker) + ',"unsafe");');
  await writeFile(resolve(dir, 'flock'), '#!/bin/sh\necho unsafe > "' + marker + '"\nexit 0\n', { mode: 0o700 });
  const previous = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, LD_PRELOAD: process.env.LD_PRELOAD };
  let holder;
  try {
    process.env.PATH = dir + ':' + previous.PATH; process.env.NODE_OPTIONS = '--require=' + preload;
    process.env.LD_PRELOAD = '/owned-nonexistent-holder-preload.so';
    holder = await acquireLock({ path, deadline: monotonicMs() + 30_000 });
    await holder.assertHeld();
    await assert.rejects(acquireLock({ path, deadline: monotonicMs() + 30_000 }), /unavailable/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await holder?.release();
  }
});

test('atomic publication fences epoch/revision, lock loss and immutable terminal receipt', async t => {
  let owns = true; const lock = { assertHeld: async () => assert(owns, 'lost lock') }, ctx = await registry(t, lock), store = ctx.store;
  let o = await publishOwnerTransition(null, await backed(ctx), lock, { store });
  await assert.rejects(publishOwnerTransition(null, await backed(ctx, 'formal'), lock, { store }), /Stale/);
  await assert.rejects(publishOwnerTransition(o, { ...o, state: 'RELEASED', revision: 2 }, lock, { store }));
  const stale = { epoch: o.epoch, revision: o.revision };
  o = await publishOwnerTransition(o, { ...o, state: 'QUIESCING', revision: 2 }, lock, { store });
  await assert.rejects(publishOwnerTransition(stale, { ...o, state: 'CLEANING', revision: 3 }, lock, { store }), /Stale/);
  owns = false; await assert.rejects(publishOwnerTransition(o, { ...o, state: 'CLEANING', revision: 3 }, lock, { store }), /lost/);
  owns = true; o = await publishOwnerTransition(o, { ...o, state: 'CLEANING', revision: 3 }, lock, { store });
  const terminal = await store.evidence(o.epoch, 'terminal', receipt(o));
  o = await publishOwnerTransition(o, { ...o, state: 'RELEASED', revision: 4, evidence: { ...o.evidence, terminal } }, lock, { store });
  const bytes = await readFile(physical(ctx, terminal));
  await publishOwnerTransition(o, await backed(ctx, 'formal'), lock, { store });
  await assert.rejects(publishOwnerTransition(o, { ...o, state: 'UNRESOLVED', revision: 5 }, lock, { store }), /Stale/);
  assert.deepEqual(await readFile(physical(ctx, terminal)), bytes);
  await writeFile(physical(ctx, terminal), '{}');
  await assert.rejects(assertAdmissionPredecessor(o, { store }), /digest/);
});

test('same-holder concurrent callbacks cannot commit the same expected revision', async t => {
  const ctx = await registry(t), store = ctx.store;
  const o = await publishOwnerTransition(null, await backed(ctx), held, { store });
  const results = await Promise.allSettled(['QUIESCING', 'UNRESOLVED'].map(state => publishOwnerTransition(o, { ...o, state, revision: 2 }, held, { store })));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal((await store.read()).state, 'QUIESCING');
});

test('unlock observation timeout cannot abandon a submitted canonical write', async t => {
  const dir = await fixture(t), path = resolve(dir, 'owned.lock'); await writeFile(path, '');
  const holder = await acquireLock({ path, deadline: monotonicMs() + 30_000 });
  let enter, finish; const entered = new Promise(done => { enter = done; }), finishing = new Promise(done => { finish = done; });
  let publication;
  try {
    const ctx = await registry(t, holder), write = ctx.store.write;
    ctx.store.write = async value => { enter(); await finishing; await write(value); };
    publication = publishOwnerTransition(null, await backed(ctx), holder, { store: ctx.store }); publication.catch(() => {});
    await observeWithin(entered, 2000);
    const release = await holder.release(); assert.equal(release.status, 'UNKNOWN'); assert.equal(release.pendingPublication, true);
    await assert.rejects(acquireLock({ path, deadline: monotonicMs() + 30_000 }), /unavailable/);
    await assert.rejects(holder.assertHeld()); finish(); await publication;
    assert.equal((await holder.release()).status, 'UNLOCKED');
    const next = await acquireLock({ path, deadline: monotonicMs() + 30_000 }); await next.release();
  } finally { finish(); await publication?.catch(() => {}); await holder.release(); }
});

test('settled resources can RELEASE despite business failure; PG UNKNOWN cannot', async t => {
  for (const pg of ['SETTLED', 'UNKNOWN']) {
    const ctx = await registry(t), b = new BorrowedRedis({ allocation: { ...allocation(), authorityRef: ctx.initial.authorityRef }, directory: ctx.dir, repo, runId: 'pure-fixture', source: {} });
    b.store = ctx.store; b.holder = { ...held, release: async () => ({ status: 'UNLOCKED' }) };
    b.owner = await publishOwnerTransition(null, await backed(ctx), b.holder, { store: ctx.store }); b.epoch = b.owner.epoch; b.activationAttempted = true;
    await b.transition('QUIESCING'); await b.transition('CLEANING');
    const out = await b.settle({ writers: { status: 'STOPPED', ambiguousEffects: false }, redis: { status: 'SETTLED' }, postgres: { status: pg }, lifecycle: 'SETTLED' });
    assert.equal(out.status, pg === 'SETTLED' ? 'RELEASED' : 'UNRESOLVED');
    const before = await readFile(physical(ctx, out.evidence)); assert.equal((await b.unlock()).status, 'UNLOCKED');
    assert.deepEqual(await readFile(physical(ctx, out.evidence)), before, 'unlock must not mutate hashed terminal');
  }
});

// A wire connector, not a fake Redis class: actual installed ioredis owns
// command timers, offline/command queues, reconnection and response processing.
function wireFixture(respond = () => '+OK\r\n') {
  const streams = [], writes = []; let connects = 0;
  class Wire extends Duplex {
    constructor() { super(); this.connecting = false; this.buffer = Buffer.alloc(0); }
    _read() {}
    setNoDelay() {}
    setKeepAlive() {}
    setTimeout() {}
    _write(chunk, encoding, callback) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length) {
        let offset = 0;
        const line = () => { const end = this.buffer.indexOf('\r\n', offset); if (end < 0) return null; const v = this.buffer.subarray(offset, end).toString(); offset = end + 2; return v; };
        const head = line(); if (head === null) break;
        const count = Number(head.slice(1)), command = []; let complete = true;
        for (let i = 0; i < count; i++) {
          const size = line(); if (size === null || offset + Number(size.slice(1)) + 2 > this.buffer.length) { complete = false; break; }
          const length = Number(size.slice(1)); command.push(this.buffer.subarray(offset, offset + length).toString()); offset += length + 2;
        }
        if (!complete) break;
        this.buffer = this.buffer.subarray(offset); writes.push(command);
        const response = respond(command, streams.length);
        if (response !== null) queueMicrotask(() => { if (!this.destroyed) this.push(response); });
      }
      callback();
    }
  }
  class Connector {
    connect() { connects++; this.stream = new Wire(); streams.push(this.stream); return Promise.resolve(this.stream); }
    disconnect() { this.stream?.destroy(); }
    check() { return true; }
  }
  return { Connector, streams, writes, connects: () => connects };
}
function control(wire, overrides = {}) {
  return new ControlRedis({ Redis: installedRedis(), options: { Connector: wire.Connector }, authority: async () => {},
    deadline: monotonicMs() + 10_000, timeoutMs: 80, ...overrides });
}

test('D1 installed default timeout rejects but leaves queued command eligible for reconnect replay', async t => {
  const wire = wireFixture((cmd, connection) => cmd[0] === 'del' && connection === 1 ? null : cmd[0] === 'del' ? ':1\r\n' : '+OK\r\n');
  const Redis = installedRedis();
  const client = new Redis({ Connector: wire.Connector, lazyConnect: true, db: 13, commandTimeout: 80,
    disableClientInfo: true, enableReadyCheck: false, retryStrategy: attempt => attempt <= 1 ? 1 : null });
  client.on('error', () => {});
  t.after(() => { client.disconnect(); for (const stream of wire.streams) stream.destroy(); });
  await client.connect();
  await assert.rejects(client.del('owned-fixture'), /timed out/);
  assert(client.commandQueue.length > 0, 'Promise timeout did not retract the queued wire command');
  wire.streams[0].destroy();
  await waitFor(() => wire.writes.filter(cmd => cmd[0] === 'del').length === 2);
  assert.equal(wire.connects(), 2);
});

test('D1 control uses actual library with explicit SELECT ACK and no offline queue/reconnect/resend', async t => {
  const wire = wireFixture(cmd => cmd[0] === 'del' ? null : '+OK\r\n');
  const c = control(wire); t.after(() => c.close());
  for (const [key, value] of Object.entries(CONTROL_OPTIONS)) if (!['connectTimeout', 'commandTimeout'].includes(key)) assert.equal(c.client.options[key], value);
  await assert.rejects(c.command('del', 'demo:sync-request:job-lease-1'), /cannot submit/);
  assert.equal(c.client.offlineQueue.length, 0); assert.equal(wire.connects(), 0);
  await c.connect();
  assert.equal(wire.writes.filter(cmd => cmd[0] === 'select').length, 2);
  await assert.rejects(c.command('del', 'demo:sync-request:job-lease-1'), /UNKNOWN/);
  assert.equal(c.effectUnknown, true); assert.equal(c.operations[0].outcome, 'UNKNOWN');
  await assert.rejects(c.command('del', 'demo:sync-request:job-lease-1'));
  await new Promise(done => setTimeout(done, 120));
  assert.equal(wire.writes.filter(cmd => cmd[0] === 'del').length, 1);
  assert.equal(wire.connects(), 1);
  assert.equal(c.client.offlineQueue.length, 0);
});

test('D1 holder/epoch invalidation is sticky and close cannot invent ACK for issued mutation', async t => {
  const wire = wireFixture(cmd => cmd[0] === 'del' ? null : '+OK\r\n');
  let held = true;
  const c = control(wire, { authority: async () => assert(held, 'lost') }); t.after(() => c.close());
  await c.connect();
  const mutation = c.command('del', 'demo:sync-request:job-request-2');
  const rejected = assert.rejects(mutation, /UNKNOWN/);
  await waitFor(() => wire.writes.some(cmd => cmd[0] === 'del'));
  held = false; c.invalidate('holder-lost'); await rejected;
  held = true;
  await assert.rejects(c.command('ping'));
  const stopped = await c.close(); assert(stopped.effectUnknown);
  assert.equal(wire.writes.filter(cmd => cmd[0] === 'del').length, 1);
});

test('D1 authority loss before write forbids later revival; deadline prevents submission', async t => {
  const wire = wireFixture(); let held = true;
  const c = control(wire, { authority: async () => assert(held) }); t.after(() => c.close());
  await c.connect(); held = false;
  await assert.rejects(c.command('set', 'demo:sync-request:job-lease-1', 'v'));
  held = true; await assert.rejects(c.command('set', 'demo:sync-request:job-lease-1', 'v'));
  assert.equal(wire.writes.filter(cmd => cmd[0] === 'set').length, 0);
  assert.equal(c.effectUnknown, false);
  const expired = control(wireFixture(), { deadline: monotonicMs() - 1 }); t.after(() => expired.close());
  await assert.rejects(expired.connect());
});

test('exact key classifier includes every source family/encoding and rejects suffix or prefix lookalikes', () => {
  const ids = ['job-lease-1', 'job-request-2', 'job-independent-box-3', 'job-box-owner-loss-4', 'job-box-release-5',
    'job-shared-box-6', 'job-keepalive-replaced-7', 'job-keepalive-scheduler-8', 'job-keepalive-scheduler-8-other',
    'job-keepalive-race-9', 'job-keepalive-10', 'manual-shared-11', 'manual-target-12', 'manual-invalid-13', 'manual-cas-14',
    'job-scheduler-15-a', 'job-scheduler-15-b', 'lane-runtime-16', 'lane-control-17', 'lane-health-18', 'lane-sparse-19'];
  for (const id of ids) {
    assert(expectedFixtureKey(`demo:sync-request:${id}`));
    for (const segment of ['\0scheduler', '中文/nested', 'archive', 'first', 'second', '%', 'a:b', "!'()*~-_."]) {
      assert(expectedFixtureKey(`demo:sync-lock:v2:${id}:${encodeURIComponent(segment)}`));
    }
  }
  assert(expectedFixtureKey('demo:sync-request:demo-lua-12345678-1234-1234-1234-123456789abc'));
  for (const bad of ['demo:*', 'demo:sync-request:job-lease-1\n', 'demo:sync-request:job-lease-1\0', 'demo:sync-request:job-lease-1-other',
    'demo:sync-lock:v2:job-lease-1:%2f', 'demo:sync-lock:v2:job-lease-1:%', 'demo:sync-lock:v2:job-lease-1:x:y',
    'demo:sync-lock:v2:job-lease-1:中文', 'foreign', 'demo:sync-request:job-anything-1']) assert(!expectedFixtureKey(bad), bad);
});

test('bounded inventory dedupes and follows empty nonzero pages; unknown key aborts before any delete', async () => {
  const key = 'demo:sync-request:job-lease-1', calls = [];
  let pages = [['7', []], ['9', [key, key]], ['0', [key]]];
  const c = { command: async (...args) => { calls.push(args); return pages.shift(); } };
  assert.deepEqual(await collectFixtureKeys(c), [key]); assert.equal(calls.length, 3);
  assert(calls.every(call => call[0] === 'scan'));
  pages = [['0', [key, 'foreign']]]; await assert.rejects(collectFixtureKeys(c), /Unexpected/);
  await assert.rejects(collectFixtureKeys({ command: async () => ['1', []] }, { maxPages: 2 }), /incomplete/);
  await assert.rejects(collectFixtureKeys({ command: async () => ['0', [key]] }, { maxBytes: 1 }), /limit/);
  await assert.rejects(collectFixtureKeys({ command: async () => ['0', [key, key]] }, { maxKeys: 1 }), /page/);
});

test('exact deletion records intent before bounded batches; lost reply is not ACK or an implicit retry', async () => {
  const keys = Array.from({ length: 65 }, (_, n) => `demo:sync-request:job-lease-${n}`), order = [];
  const c = { command: async (name, ...batch) => { order.push([name, ...batch]); return batch.length; } };
  const out = await deleteExactKeys(c, keys, async exact => { assert.deepEqual(exact, keys); order.push(['intent']); });
  assert.equal(order[0][0], 'intent'); assert.deepEqual(out.batches.map(b => b.deleted), [64, 1]);
  let attempts = 0;
  await assert.rejects(deleteExactKeys({ command: async () => { attempts++; throw new Error('lost response'); } }, keys));
  assert.equal(attempts, 1);
  await assert.rejects(deleteExactKeys(c, ['demo:*']));
});

test('holder rejects expired, nonfinite and over3900s windows before opening any lock', async t => {
  const dir = await fixture(t), path = resolve(dir, 'does-not-exist.lock');
  for (const deadline of [NaN, Infinity, -1, monotonicMs() - 1, monotonicMs() + 3_901_000]) {
    await assert.rejects(acquireLock({ path, deadline }), /finite holder window/);
  }
});

test('owned temporary flock is nonblocking and normal release has a distinct receipt', async t => {
  const dir = await fixture(t), path = resolve(dir, 'owned.lock'); await writeFile(path, '');
  let losses = 0;
  const holder = await acquireLock({ path, deadline: monotonicMs() + 30_000, onLost: () => losses++ });
  t.after(() => holder.release());
  await holder.assertHeld();
  await assert.rejects(acquireLock({ path, deadline: monotonicMs() + 30_000 }), /unavailable/);
  assert.equal((await holder.release()).status, 'UNLOCKED'); assert.equal(losses, 0);
  await assert.rejects(holder.assertHeld());
  const next = await acquireLock({ path, deadline: monotonicMs() + 30_000 });
  assert.equal((await next.release()).status, 'UNLOCKED');
});

test('lost guardian cannot unlock an in-flight parent publication descriptor', async t => {
  const dir = await fixture(t), path = resolve(dir, 'owned.lock'); await writeFile(path, '');
  let lost = false;
  const holder = await acquireLock({ path, deadline: monotonicMs() + 30_000, onLost: () => { lost = true; } });
  t.after(() => holder.release());
  process.kill(holder.identity.guardianPid, 'SIGKILL');
  await waitFor(() => lost);
  await assert.rejects(holder.assertHeld());
  await assert.rejects(acquireLock({ path, deadline: monotonicMs() + 30_000 }), /unavailable/);
  assert.equal((await holder.release()).status, 'UNKNOWN');
  const next = await acquireLock({ path, deadline: monotonicMs() + 30_000 });
  await next.release();
});

test('holder parent death and finite guardian deadline release only the owned fixture lock', async t => {
  for (const mode of ['parent-death', 'deadline']) {
    const dir = await fixture(t), path = resolve(dir, 'owned.lock'); await writeFile(path, '');
    const script = `import {acquireLock,monotonicMs} from ${JSON.stringify(new URL('./redis.mjs', import.meta.url).href)};
      const h=await acquireLock({path:${JSON.stringify(path)},deadline:monotonicMs()+${mode === 'deadline' ? 1600 : 30_000}});
      console.log('READY');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    const exited = once(child, 'close');
    await observeWithin(new Promise(done => child.stdout.on('data', b => { if (String(b).includes('READY')) done(); })), 2000);
    if (mode === 'parent-death') child.kill('SIGKILL');
    await observeWithin(exited, 3000);
    let next;
    await waitFor(async () => { try { next = await acquireLock({ path, deadline: monotonicMs() + 30_000 }); return true; } catch { return false; } });
    await next.release();
  }
});

// NOTE: the producing repo also pins a test asserting that run.mjs (the pinned
// CI runner) rejects a missing allocation before any Git/env work, and that the
// host launcher forwards new arguments verbatim. That runner is repo-specific
// and not part of this kit; the equivalent guard lives wherever you wrap
// BorrowedRedis admission.

test('installed control client rejects fresh admission conflicts using only bounded public metadata', async t => {
  const bulk = value => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  for (const scenario of ['ok', 'wrong-generation', 'other-client', 'wrong-db', 'pubsub', 'nonempty', 'db-count']) {
    const wire = wireFixture(cmd => {
      if (cmd[0] === 'select') return '+OK\r\n';
      if (cmd[0] === 'ping') return '+PONG\r\n';
      if (cmd[0] === 'info') return bulk(`run_id:${(scenario === 'wrong-generation' ? 'd' : 'c').repeat(40)}\r\n`);
      if (cmd[0] === 'client' && cmd[1] === 'ID') return ':1\r\n';
      if (cmd[0] === 'client') return bulk(`id=1 db=${scenario === 'wrong-db' ? '0' : '13'} flags=N\n${scenario === 'other-client' ? 'id=2 db=13 flags=N\n' : ''}`);
      if (cmd[0] === 'pubsub' && cmd[1] === 'NUMPAT') return scenario === 'pubsub' ? ':1\r\n' : ':0\r\n';
      if (cmd[0] === 'pubsub') return '*0\r\n';
      if (cmd[0] === 'config') return `*2\r\n${bulk('databases')}${bulk(scenario === 'db-count' ? '1' : '16')}`;
      if (cmd[0] === 'dbsize') return scenario === 'nonempty' ? ':1\r\n' : ':0\r\n';
      throw new Error('unexpected command');
    });
    const c = control(wire); t.after(() => c.close()); await c.connect();
    if (scenario === 'ok') assert.equal((await verifyRedisAdmission(c, 'c'.repeat(40))).clients, 1);
    else await assert.rejects(verifyRedisAdmission(c, 'c'.repeat(40)));
    assert(wire.writes.every(cmd => !['del', 'set', 'flushdb', 'flushall', 'keys'].includes(cmd[0])));
    await c.close();
  }
});

test('control SELECT failure cannot send a data mutation in an unintended DB', async t => {
  const wire = wireFixture(cmd => cmd[0] === 'select' ? '-ERR DB index is out of range\r\n' : '+OK\r\n');
  const c = control(wire); t.after(() => c.close());
  await assert.rejects(c.connect());
  await assert.rejects(c.command('set', 'demo:sync-request:job-lease-1', 'v'));
  assert(!wire.writes.some(cmd => cmd[0] === 'set'));
});

test('unexpected occupancy at deletion checkpoint sends no DEL; ACK evidence failure stops later batches', async () => {
  let sent = 0;
  const control = { command: async (name, ...keys) => { sent++; return keys.length; } };
  const keys = Array.from({ length: 65 }, (_, i) => `demo:sync-request:job-lease-${i}`);
  await assert.rejects(deleteExactKeys(control, keys, async () => {}, async () => { throw new Error('foreign consumer'); }));
  assert.equal(sent, 0);
  await assert.rejects(deleteExactKeys(control, keys, async () => {}, async () => {}, async () => { throw new Error('receipt write failed'); }));
  assert.equal(sent, 1, 'cannot send the second batch after losing its ACK evidence');
});

test('resource, PG, owner, unlock and result failures do not short-circuit safe independent finalizers', async () => {
  const result = { passed: true }, visited = [];
  for (const stage of ['writers', 'redis', 'postgres', 'owner', 'holder', 'resultPublication']) {
    await recordCleanup(result, stage, async () => { visited.push(stage); throw new Error('SECRET driver command'); });
  }
  await recordCleanup(result, 'combinedLog', async () => { visited.push('combinedLog'); return { status: 'SETTLED' }; });
  assert.equal(visited.length, 7); assert.equal(result.passed, false);
  assert.equal(result.cleanup.postgres.status, 'UNKNOWN');
  assert.equal(result.cleanup.combinedLog.status, 'SETTLED');
  assert(!JSON.stringify(result).includes('SECRET'));
});

test('declared gate boundaries keep the default lane equal to today constants and reject unknown values', () => {
  // literal pins (F4): the right-hand sides must NOT reference this module's own
  // constants — they pin the live lane1 allocation file and durable root as-is
  assert.equal(GATE_BOUNDARY.root, '/var/lib/agent-ci-kit/shared-gate');
  assert.equal(GATE_BOUNDARY.ownerPath, '/var/lib/agent-ci-kit/shared-gate/owner.json');
  assert.equal(GATE_BOUNDARY.authorityPath, '/var/lib/agent-ci-kit/shared-gate/authority.json');
  assert.equal(GATE_BOUNDARY.lockPath, '/var/lib/agent-ci-kit/locks/redis-integration.lock');
  assert.equal(GATE_BOUNDARY.service, 'gate-redis');
  assert.equal(GATE_BOUNDARY.host, '127.0.0.1');
  assert.equal(GATE_BOUNDARY.port, 16379);
  assert.deepEqual({ ...GATE_BOUNDARY.namespaces }, { ci: 13, formal: 14 });
  // internal consistency with the exported legacy constants
  assert.equal(GATE_BOUNDARY.root, GATE_ROOT);
  assert.equal(GATE_BOUNDARY.ownerPath, GATE_OWNER_PATH);
  assert.equal(GATE_BOUNDARY.authorityPath, GATE_AUTHORITY_PATH);
  assert.equal(GATE_BOUNDARY.lockPath, GATE_LOCK_PATH);
  assert.equal(GATE_BOUNDARIES[0], GATE_BOUNDARY);
  assert.equal(GATE_BOUNDARIES.length, 2);
  const lane2 = GATE_BOUNDARIES[1];
  assert.equal(lane2.service, 'gate-redis-ci2');
  assert.equal(lane2.host, '127.0.0.1');
  assert.equal(lane2.port, 16380);
  assert.deepEqual({ ...lane2.namespaces }, { ci: 13, formal: 14 });
  assert.equal(lane2.root, '/var/lib/agent-ci-kit/shared-gate-lane2');
  assert.equal(lane2.ownerPath, '/var/lib/agent-ci-kit/shared-gate-lane2/owner.json');
  assert.equal(lane2.authorityPath, '/var/lib/agent-ci-kit/shared-gate-lane2/authority.json');
  assert.equal(lane2.lockPath, '/var/lib/agent-ci-kit/locks/redis-integration-lane2.lock');
  assert.equal(gateBoundary(lane2), lane2);
  assert.equal(gateBoundary(GATE_BOUNDARY), GATE_BOUNDARY);
  assert.throws(() => gateBoundary({ ...GATE_BOUNDARY, port: 16381 }));
  assert.throws(() => gateBoundary({ ...lane2, service: 'gate-redis-ci3' }));
  assert.throws(() => gateBoundary(null));
});

test('parseAllocation accepts exactly the declared lanes; a third boundary is not introducible', () => {
  const lane2 = GATE_BOUNDARIES[1];
  assert.equal(parseAllocation(allocation(lane2)).port, 16380);
  assert.equal(allocationBoundary(allocation(lane2)), lane2);
  assert.equal(allocationBoundary(allocation()), GATE_BOUNDARY);
  for (const patch of [{ port: 16381 }, { port: 6379 }, { service: 'gate-redis-ci3' }, { host: 'some-host' },
    { ownerPath: '/var/lib/agent-ci-kit/shared-gate-lane3/owner.json' }, { lockPath: '/tmp/another-lock' }, { db: 14 }]) {
    assert.throws(() => parseAllocation({ ...allocation(lane2), ...patch }), JSON.stringify(patch));
    assert.throws(() => allocationBoundary({ ...allocation(lane2), ...patch }), JSON.stringify(patch));
  }
  // lane1-tampered allocations stay rejected by the same whitelist
  for (const patch of [{ port: 16380 }, { service: 'gate-redis-ci2' }]) {
    assert.throws(() => parseAllocation({ ...allocation(), ...patch }), JSON.stringify(patch));
  }
  const result = borrowedResult(allocation(lane2));
  assert.equal(result.service.port, 16380);
  assert.equal(result.db, 13);
  assert.equal(result.ownerPath, lane2.ownerPath);
});

test('owner envelope validates only against its own lane boundary', () => {
  const lane2 = GATE_BOUNDARIES[1];
  assert.equal(parseGateOwner(envelope('ci', 'ACTIVE', lane2), { boundary: lane2 }).instance.port, 16380);
  assert.throws(() => parseGateOwner(envelope('ci', 'ACTIVE', lane2)), /Invalid/);
  assert.throws(() => parseGateOwner(envelope('ci', 'ACTIVE', lane2), { boundary: GATE_BOUNDARY }));
  assert.throws(() => parseGateOwner(envelope(), { boundary: lane2 }), /Invalid/);
  // db semantics are identical across lanes: a formal envelope on lane2 still needs db14
  assert.throws(() => parseGateOwner({ ...envelope('formal', 'ACTIVE', lane2), namespace: { redisDb: 13, exclusive: true } }, { boundary: lane2 }));
});

test('lane2 durable root initializes, publishes and settles through its own boundary', async t => {
  const lane2 = GATE_BOUNDARIES[1];
  const ctx = await registry(t, held, lane2);
  const authority = await readJSON(resolve(ctx.root, 'authority.json'));
  assert.equal(authority.service, 'gate-redis-ci2');
  assert.equal(authority.host, '127.0.0.1');
  assert.equal(authority.port, 16380);
  assert.deepEqual(authority.namespaces, { ci: 13, formal: 14 });
  assert.equal(ctx.initial.authorityRef.path, lane2.authorityPath);
  const owner = await released(ctx);
  assert.equal(owner.instance.port, 16380);
  assert.equal(owner.namespace.redisDb, 13);
  assert.equal(owner.holder.lockPath, lane2.lockPath);
  await assertAdmissionPredecessor(owner, { store: ctx.store });
  assert.equal((await ctx.store.initialization()).state, 'CONSUMED');
  // a lane2 owner never validates against the lane1 store/boundary
  const lane1ctx = await registry(t);
  await assert.rejects(publishOwnerTransition(null, await backed(ctx), held, { store: lane1ctx.store }), /Invalid/);
});

test('ControlRedis connects and SELECTs by its lane boundary; inspectGate checks the lane port', async t => {
  const lane2 = GATE_BOUNDARIES[1];
  const wire = wireFixture();
  const c = new ControlRedis({ Redis: installedRedis(), options: { Connector: wire.Connector }, authority: async () => {},
    deadline: monotonicMs() + 10_000, timeoutMs: 80, boundary: lane2 });
  t.after(() => c.close());
  assert.equal(c.client.options.host, '127.0.0.1');
  assert.equal(c.client.options.port, 16380);
  assert.equal(c.client.options.db, 13);
  await c.connect();
  assert.deepEqual(wire.writes.filter(cmd => cmd[0] === 'select'), [['select', '13'], ['select', '13']]);

  const inspect = async (port, boundary) => inspectGate({ containerId: 'b'.repeat(64) }, { boundary, exec: async () => ({ stdout: JSON.stringify({ id: 'b'.repeat(64), running: true, ports: [{ HostIp: '127.0.0.1', HostPort: port }] }) }) });
  assert.deepEqual(await inspect('16380', lane2), { containerId: 'b'.repeat(64), running: true, host: '127.0.0.1', port: 16380 });
  await assert.rejects(inspect('16379', lane2), /identity\/mapping/);
  await assert.rejects(inspect('16380', GATE_BOUNDARY), /identity\/mapping/);
});

test('BorrowedRedis derives store and result from the allocation lane', async t => {
  const lane2 = GATE_BOUNDARIES[1];
  const ctx = await registry(t, held, lane2);
  const b = new BorrowedRedis({ allocation: { ...allocation(lane2), authorityRef: ctx.initial.authorityRef }, directory: ctx.dir, repo, runId: 'pure-fixture', source: {} });
  assert.equal(b.store.boundary, lane2);
  assert.equal(b.boundary, lane2);
  assert.equal(b.result.service.port, 16380);
  assert.equal(b.result.ownerPath, lane2.ownerPath);
  b.store = ctx.store;
  assert.equal(b.store.boundary, lane2);
});

test('ownerEnvelope wires every boundary-carrying field from the given lane', () => {
  const lane2 = GATE_BOUNDARIES[1];
  const a = allocation(lane2);
  const identity = { pid: 4242, startTicks: '172520512', bootId: '11111111-1111-1111-1111-111111111111' };
  const evidence = { path: `${lane2.root}/receipts/${'e'.repeat(32)}/admission.json`, sha256: 'a'.repeat(64) };
  const envelope = ownerEnvelope({ boundary: lane2, allocation: a, identity, epoch: 'e'.repeat(32), runId: 'pure-fixture', anchorMs: 1000, evidence });
  assert.equal(envelope.holder.lockPath, lane2.lockPath);
  assert.equal(envelope.instance.host, '127.0.0.1');
  assert.equal(envelope.instance.port, 16380);
  assert.equal(envelope.instance.containerId, a.containerId);
  assert.equal(envelope.instance.serverRunId, a.serverRunId);
  assert.equal(envelope.namespace.redisDb, 13);
  assert.equal(envelope.authorityRef.path, lane2.authorityPath);
  assert.equal(envelope.initializationId, a.initializationId);
  // the constructed envelope is a valid ACTIVE owner for its own lane only
  assert.equal(parseGateOwner(envelope, { boundary: lane2 }).state, 'ACTIVE');
  assert.throws(() => parseGateOwner(envelope), /Invalid/);
  // a lane1 construction is likewise self-consistent (default boundary)
  const envelope1 = ownerEnvelope({ boundary: GATE_BOUNDARY, allocation: allocation(), identity, epoch: 'e'.repeat(32), runId: 'pure-fixture', anchorMs: 1000, evidence });
  assert.equal(envelope1.holder.lockPath, GATE_LOCK_PATH);
  assert.equal(envelope1.instance.port, 16379);
  assert.equal(envelope1.namespace.redisDb, 13);
  assert.throws(() => parseGateOwner(envelope1, { boundary: lane2 }), /Invalid/);
});

test('real borrowed Redis regression only deletes its own small fixture and never transitions outer owner', {
  skip: process.env.AGENT_CI_REDIS_TESTS !== '1', timeout: 10_000,
}, async () => {
  const url = new URL(process.env.AGENT_CI_REDIS_URL);
  const boundary = GATE_BOUNDARIES.find(lane => lane.host === url.hostname && lane.port === Number(url.port));
  assert(boundary, 'test Redis URL must address a declared gate boundary');
  assert.equal(url.pathname.slice(1), String(boundary.namespaces.ci));
  const o = parseGateOwner(await readJSON(boundary.ownerPath), { boundary });
  assert.equal(o.state, 'ACTIVE'); assert.equal(o.purpose, 'ci'); assert.equal(o.epoch, process.env.AGENT_CI_REDIS_EPOCH);
  const c = new ControlRedis({ Redis: installedRedis(), boundary, deadline: Math.min(o.window.workDeadlineMs, monotonicMs() + 5000), authority: async () => {
    const current = parseGateOwner(await readJSON(boundary.ownerPath), { boundary });
    assert.equal(current.epoch, o.epoch); assert.equal(current.revision, o.revision); assert.equal(current.state, 'ACTIVE');
    const holder = await processIdentity(o.holder.pid);
    assert.equal(holder.startTicks, o.holder.startTicks); assert.equal(holder.bootId, o.holder.bootId);
    assert(!['Z', 'X'].includes(holder.state));
  } });
  const id = `ci-redis-probe-${randomBytes(16).toString('hex')}`;
  const keys = [`demo:sync-request:${id}`, `demo:sync-lock:v2:${id}:%00scheduler`, `demo:sync-lock:v2:${id}:%E4%B8%AD%E6%96%87%2Fnested`];
  let settled = false;
  try {
    await c.connect();
    for (const key of keys) assert.equal(await c.command('set', key, 'own-regression', 'NX', 'PX', '60000'), 'OK');
    await deleteExactKeys(c, keys);
    assert.equal(await c.command('exists', ...keys), 0);
    settled = true;
  } finally {
    if (!settled && !c.invalid) await deleteExactKeys(c, keys).catch(() => {});
    const closed = await c.close();
    await immutableJSON(process.env.AGENT_CI_REDIS_EVIDENCE, { version: 1, epoch: o.epoch,
      status: settled && closed.status === 'CLOSED' && !c.effectUnknown ? 'SETTLED' : 'UNKNOWN' });
  }
});
