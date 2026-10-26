import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECT_PENDING_STORAGE_KEY,
  CONNECT_TTL_MS,
  activeConnectAttempt,
  beginConnectAttempt,
  browserLabel,
  cancelConnectAttempt,
  connectUrl,
  createExternalMessageHandler,
} from '../notes-api-connect.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const NOTES = { origin: 'https://notes.lab', url: 'https://notes.lab/' };

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))]));
    },
    async set(values) { Object.entries(values).forEach(([key, value]) => data.set(key, structuredClone(value))); },
    async remove(keys) { keys.forEach((key) => data.delete(key)); },
  };
}

function setup({ pending = true, exchange } = {}) {
  let nowMs = 1_800_000_000_000;
  const storage = createStorage();
  const exchanges = [];
  const handler = createExternalMessageHandler({
    storage,
    runtimeId: EXTENSION_ID,
    browser: () => 'Chrome · macOS',
    now: () => nowMs,
    exchange: exchange || (async (input) => { exchanges.push(input); }),
  });
  const ready = pending ? beginConnectAttempt({ storage, now: () => nowMs }) : Promise.resolve();
  return { storage, handler, exchanges, ready, advance(ms) { nowMs += ms; }, now: () => nowMs };
}

const probe = { type: 'notes-lab.connect.probe', notes_origin: 'https://notes.lab' };
const pair = {
  type: 'notes-lab.connect.pair',
  notes_origin: 'https://notes.lab',
  pairing_id: 'pairing-synthetic-1',
  code: 'synthetic-code-123',
  label: 'Sidepad · Chrome · macOS',
};

test('connect URL carries only the runtime id in the fragment', () => {
  assert.equal(connectUrl(EXTENSION_ID), `https://notes.lab/#sidepad-connect=${EXTENSION_ID}`);
  assert.throws(() => connectUrl('not-an-id'), TypeError);
});

test('pending attempt lives at most ten minutes and can be cancelled', async () => {
  const ctx = setup();
  await ctx.ready;
  const stored = ctx.storage.data.get(CONNECT_PENDING_STORAGE_KEY);
  assert.equal(stored.expiresAt - ctx.now(), CONNECT_TTL_MS);
  assert.ok(CONNECT_TTL_MS <= 10 * 60 * 1000);
  assert.ok(await activeConnectAttempt({ storage: ctx.storage, now: ctx.now }));
  ctx.advance(CONNECT_TTL_MS);
  assert.equal(await activeConnectAttempt({ storage: ctx.storage, now: ctx.now }), null);
  assert.equal(ctx.storage.data.has(CONNECT_PENDING_STORAGE_KEY), false);

  await beginConnectAttempt({ storage: ctx.storage, now: ctx.now });
  await cancelConnectAttempt(ctx.storage);
  assert.equal(await activeConnectAttempt({ storage: ctx.storage, now: ctx.now }), null);
});

test('forged or overlong pending records are discarded', async () => {
  const ctx = setup({ pending: false });
  ctx.storage.data.set(CONNECT_PENDING_STORAGE_KEY, { version: 1, expiresAt: ctx.now() + CONNECT_TTL_MS + 1 });
  assert.equal(await activeConnectAttempt({ storage: ctx.storage, now: ctx.now }), null);
  ctx.storage.data.set(CONNECT_PENDING_STORAGE_KEY, 'junk');
  assert.equal(await activeConnectAttempt({ storage: ctx.storage, now: ctx.now }), null);
});

test('probe answers with identity and expiry only while an attempt is pending', async () => {
  const ctx = setup();
  await ctx.ready;
  const response = await ctx.handler(probe, NOTES);
  assert.deepEqual(response, {
    ok: true,
    extension_id: EXTENSION_ID,
    name: 'Sidepad',
    browser: 'Chrome · macOS',
    pending_expires_at: Math.floor((ctx.now() + CONNECT_TTL_MS) / 1000),
  });

  const idle = setup({ pending: false });
  assert.deepEqual(await idle.handler(probe, NOTES), { ok: false });
});

test('messages from other origins, extra fields or wrong types are rejected', async () => {
  const ctx = setup();
  await ctx.ready;
  const cases = [
    [probe, { origin: 'https://evil.test', url: 'https://evil.test/' }],
    [probe, { origin: 'http://notes.lab', url: 'http://notes.lab/' }],
    [probe, { url: 'https://notes.lab/' }],
    [{ ...probe, extra: 1 }, NOTES],
    [{ ...probe, notes_origin: 'https://other.lab' }, NOTES],
    [{ type: 'notes-lab.connect.unknown', notes_origin: 'https://notes.lab' }, NOTES],
    [null, NOTES],
    [[probe], NOTES],
    [{ ...pair, code: 42 }, NOTES],
    [{ ...pair, label: '' }, NOTES],
    [{ ...pair, label: 'x'.repeat(81) }, NOTES],
    [{ ...pair, pairing_id: '' }, NOTES],
    [{ ...pair, secret: 'x' }, NOTES],
  ];
  for (const [message, sender] of cases) {
    assert.deepEqual(await ctx.handler(message, sender), { ok: false }, JSON.stringify([message, sender]));
  }
  assert.deepEqual(ctx.exchanges, []);
  assert.ok(await activeConnectAttempt({ storage: ctx.storage, now: ctx.now }));
});

test('pair exchanges once, clears the attempt and confirms only after success', async () => {
  const ctx = setup();
  await ctx.ready;
  assert.deepEqual(await ctx.handler(pair, NOTES), { ok: true });
  assert.deepEqual(ctx.exchanges, [{ pairingId: pair.pairing_id, code: pair.code, label: pair.label }]);
  assert.equal(ctx.storage.data.has(CONNECT_PENDING_STORAGE_KEY), false);
  assert.deepEqual(await ctx.handler(pair, NOTES), { ok: false });
  assert.equal(ctx.exchanges.length, 1);
});

test('pair without a pending attempt or after expiry never calls the server', async () => {
  const idle = setup({ pending: false });
  assert.deepEqual(await idle.handler(pair, NOTES), { ok: false });
  assert.deepEqual(idle.exchanges, []);

  const late = setup();
  await late.ready;
  late.advance(CONNECT_TTL_MS + 1);
  assert.deepEqual(await late.handler(pair, NOTES), { ok: false });
  assert.deepEqual(late.exchanges, []);
});

test('failed exchange answers without details and keeps the attempt for a new pairing', async () => {
  const ctx = setup({ exchange: async () => { throw Object.assign(new Error('pairing rejected: synthetic-code-123'), { reason: 'invalid-or-expired' }); } });
  await ctx.ready;
  assert.deepEqual(await ctx.handler(pair, NOTES), { ok: false });
  assert.ok(await activeConnectAttempt({ storage: ctx.storage, now: ctx.now }));
});

test('concurrent pair messages perform a single exchange', async () => {
  let release;
  let calls = 0;
  const ctx = setup({ exchange: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); } });
  await ctx.ready;
  const first = ctx.handler(pair, NOTES);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await ctx.handler(pair, NOTES), { ok: false });
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(calls, 1);
});

test('browser label names the Chromium brand and platform briefly', () => {
  const nav = (brands, platform) => ({ userAgentData: { brands: brands.map((brand) => ({ brand, version: '1' })), platform } });
  assert.equal(browserLabel(nav(['Chromium', 'Brave', 'Not=A?Brand'], 'macOS')), 'Brave · macOS');
  assert.equal(browserLabel(nav(['Chromium', 'Google Chrome'], 'macOS')), 'Chrome · macOS');
  assert.equal(browserLabel(nav(['Chromium', 'Microsoft Edge'], 'Windows')), 'Edge · Windows');
  assert.equal(browserLabel(nav(['Chromium'], 'Linux')), 'Chromium · Linux');
  assert.equal(browserLabel({}), 'Chromium');
});
