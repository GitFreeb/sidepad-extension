import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  API_CREDENTIAL_STORAGE_KEY,
  NOTES_ORIGIN,
  NotesApiAuth,
  PairingError,
} from '../notes-api-auth.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))]));
    },
    async set(values) {
      writes.push(structuredClone(values));
      Object.entries(values).forEach(([key, value]) => data.set(key, structuredClone(value)));
    },
    async remove(keys) {
      keys.forEach((key) => data.delete(key));
    },
  };
}

const issued = {
  credential_id: '11111111-1111-4111-8111-111111111111',
  credential: 'nlc_11111111-1111-4111-8111-111111111111.super-secret-value',
  scopes: ['document:read', 'document:write'],
};

test('pairing success uses the exact Notes Lab exchange without an old Bearer and exposes no secret', async () => {
  const storage = createStorage();
  const requests = [];
  const auth = new NotesApiAuth({
    storage,
    now: () => '2026-10-24T08:00:00Z',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(issued);
    },
  });
  await auth.init();

  const exchange = auth.exchange({
    pairingId: '22222222-2222-4222-8222-222222222222',
    code: '12345678',
    label: 'Sidepad temporary profile',
  });
  assert.equal(auth.snapshot().phase, 'pairing');
  const result = await exchange;

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${NOTES_ORIGIN}/api/auth/pairings/exchange`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    pairing_id: '22222222-2222-4222-8222-222222222222',
    code: '12345678',
    label: 'Sidepad temporary profile',
  });
  assert.equal(result.phase, 'current');
  assert.equal(result.credentialId, issued.credential_id);
  assert.equal(JSON.stringify(result).includes(issued.credential), false);
  assert.equal(JSON.stringify(storage.writes).includes('12345678'), false);
  assert.equal(storage.data.get(API_CREDENTIAL_STORAGE_KEY).credential, issued.credential);
});

test('an invalid pairing is rejected without retaining pairing input or a credential', async () => {
  const storage = createStorage();
  const auth = new NotesApiAuth({
    storage,
    fetchImpl: async () => jsonResponse({ error: { code: 'invalid_pairing', message: 'pairing is invalid' } }, 401),
  });

  await assert.rejects(
    auth.exchange({ pairingId: 'invalid', code: 'wrong', label: 'Sidepad' }),
    (error) => error instanceof PairingError && error.reason === 'invalid-or-expired',
  );
  assert.equal(auth.snapshot().phase, 'missing');
  assert.equal(JSON.stringify([...storage.data]).includes('wrong'), false);
  assert.equal(storage.data.has(API_CREDENTIAL_STORAGE_KEY), false);
});

test('an expired pairing has the same safe invalid-or-expired result and can be retried manually', async () => {
  let attempts = 0;
  const storage = createStorage();
  const auth = new NotesApiAuth({
    storage,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ error: { code: 'invalid_pairing', message: 'pairing is invalid or expired' } }, 401);
      }
      return jsonResponse(issued);
    },
  });

  await assert.rejects(
    auth.exchange({ pairingId: 'expired-id', code: 'expired-code', label: 'Sidepad' }),
    (error) => error instanceof PairingError && error.reason === 'invalid-or-expired',
  );
  assert.equal(attempts, 1);
  assert.equal(auth.snapshot().phase, 'missing');

  await auth.exchange({ pairingId: 'fresh-id', code: 'fresh-code', label: 'Sidepad' });
  assert.equal(attempts, 2);
  assert.equal(auth.snapshot().phase, 'current');
});

test('Bearer authorization is limited to Notes Lab content requests and never reaches another origin or pairing', async () => {
  const storage = createStorage({
    [API_CREDENTIAL_STORAGE_KEY]: {
      version: 1,
      status: 'current',
      credentialId: issued.credential_id,
      credential: issued.credential,
      scopes: issued.scopes,
      pairedAt: '2026-10-24T08:00:00Z',
    },
  });
  const auth = new NotesApiAuth({ storage, fetchImpl: async () => { throw new Error('unused'); } });
  await auth.init();

  const content = await auth.authorizeContentRequest(
    { method: 'GET', headers: { Accept: 'application/json' } },
    { resource: 'content', url: `${NOTES_ORIGIN}/api/v1/document` },
  );
  const otherOrigin = await auth.authorizeContentRequest(
    { method: 'GET', headers: {} },
    { resource: 'content', url: 'https://example.com/api/v1/document' },
  );
  const pairing = await auth.authorizeContentRequest(
    { method: 'POST', headers: {} },
    { resource: 'pairing', url: `${NOTES_ORIGIN}/api/auth/pairings/exchange` },
  );

  assert.equal(content.headers.Authorization, `Bearer ${issued.credential}`);
  assert.equal(otherOrigin.headers.Authorization, undefined);
  assert.equal(pairing.headers.Authorization, undefined);
});

for (const status of [401, 403]) {
  test(`content ${status} clears the rejected secret, persists a locked marker and restores auth-required after restart`, async () => {
    const storage = createStorage({
      [API_CREDENTIAL_STORAGE_KEY]: {
        version: 1,
        status: 'current',
        credentialId: issued.credential_id,
        credential: issued.credential,
        scopes: issued.scopes,
        pairedAt: '2026-10-24T08:00:00Z',
      },
    });
    const auth = new NotesApiAuth({
      storage,
      now: () => '2026-10-24T08:10:00Z',
      fetchImpl: async () => { throw new Error('unused'); },
    });
    await auth.init();
    await auth.rejectCredential(status);

    const stored = storage.data.get(API_CREDENTIAL_STORAGE_KEY);
    assert.equal(stored.status, 'auth-required');
    assert.equal('credential' in stored, false);
    assert.equal(JSON.stringify(stored).includes('super-secret-value'), false);
    assert.equal(auth.snapshot().phase, 'auth-required');

    const restarted = new NotesApiAuth({ storage, fetchImpl: async () => { throw new Error('unused'); } });
    await restarted.init();
    assert.equal(restarted.snapshot().phase, 'auth-required');
    assert.equal(restarted.hasCredential(), false);
  });
}

test('reset deletes only the local credential and does not claim to revoke the server credential', async () => {
  const storage = createStorage({
    [API_CREDENTIAL_STORAGE_KEY]: {
      version: 1,
      status: 'current',
      credentialId: issued.credential_id,
      credential: issued.credential,
      scopes: issued.scopes,
      pairedAt: '2026-10-24T08:00:00Z',
    },
  });
  const auth = new NotesApiAuth({ storage, fetchImpl: async () => { throw new Error('unused'); } });
  await auth.init();
  await auth.reset();

  assert.equal(auth.snapshot().phase, 'missing');
  assert.equal(storage.data.has(API_CREDENTIAL_STORAGE_KEY), false);
});

test('restart removes a malformed locked record that still contains a secret', async () => {
  const storage = createStorage({
    [API_CREDENTIAL_STORAGE_KEY]: {
      version: 1,
      status: 'auth-required',
      credential: issued.credential,
      rejectedAt: '2026-10-24T08:10:00Z',
      statusCode: 401,
    },
  });
  const auth = new NotesApiAuth({ storage, fetchImpl: async () => { throw new Error('unused'); } });

  await auth.init();

  assert.equal(auth.snapshot().phase, 'missing');
  assert.equal(storage.data.has(API_CREDENTIAL_STORAGE_KEY), false);
});

test('credential plumbing is local-only and does not expose a credential through sync, export, logs or DOM', async () => {
  const root = new URL('../', import.meta.url);
  const [authSource, popupApiSource, legacySource, html] = await Promise.all([
    readFile(new URL('notes-api-auth.js', root), 'utf8'),
    readFile(new URL('popup-api.js', root), 'utf8'),
    readFile(new URL('popup.js', root), 'utf8'),
    readFile(new URL('popup.html', root), 'utf8'),
  ]);

  assert.match(popupApiSource, /chrome\.storage\.local/);
  assert.doesNotMatch(`${authSource}\n${popupApiSource}`, /chrome\.storage\.sync/);
  assert.doesNotMatch(`${authSource}\n${popupApiSource}`, /console\./);
  assert.doesNotMatch(legacySource, /notesApiCredentialV1|API_CREDENTIAL_STORAGE_KEY/);
  assert.doesNotMatch(html, /id=["'][^"']*credential/i);
});
