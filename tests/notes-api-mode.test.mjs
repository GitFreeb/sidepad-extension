import test from 'node:test';
import assert from 'node:assert/strict';

import { NotesApiMode, API_MODE_STORAGE_KEY, API_SESSION_STORAGE_KEY } from '../notes-api-mode.js';
import { AuthRequiredError } from '../notes-api-client.js';

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))]));
    },
    async set(values) {
      Object.entries(values).forEach(([key, value]) => data.set(key, structuredClone(value)));
    },
    async remove(keys) {
      keys.forEach((key) => data.delete(key));
    },
  };
}

function createPermissions() {
  return {
    containsCalls: 0,
    requestCalls: 0,
    removeCalls: 0,
    granted: false,
    async contains() { this.containsCalls += 1; return this.granted; },
    async request() { this.requestCalls += 1; this.granted = true; return true; },
    async remove() { this.removeCalls += 1; this.granted = false; return true; },
  };
}

test('disabled mode creates no client, asks no host permission and makes no request', async () => {
  const storage = createStorage({ tabs: [{ id: 'legacy' }] });
  const permissions = createPermissions();
  let clientCreations = 0;
  const mode = new NotesApiMode({
    storage,
    permissions,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => { clientCreations += 1; return {}; },
  });

  await mode.init();

  assert.equal(mode.enabled, false);
  assert.equal(clientCreations, 0);
  assert.equal(permissions.containsCalls, 0);
  assert.equal(permissions.requestCalls, 0);
  assert.deepEqual(storage.data.get('tabs'), [{ id: 'legacy' }]);
});

test('file tabs with auto-save no longer block API mode: they keep syncing next to notes.md', async () => {
  const storage = createStorage({ tabs: [{ id: 'legacy', autoSave: true }] });
  const permissions = createPermissions();
  let clients = 0;
  const mode = new NotesApiMode({
    storage, permissions, originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => { clients += 1; return { load: async () => ({ document: { sections: [] }, revision: 'rev-1' }) }; },
  });

  assert.equal(await mode.enable(), true);
  assert.equal(permissions.requestCalls, 1);
  assert.equal(clients, 1);
  assert.equal(storage.data.get(API_MODE_STORAGE_KEY), true);

  const restarted = new NotesApiMode({
    storage, permissions, originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => ({ load: async () => ({ document: { sections: [] }, revision: 'rev-1' }) }),
  });
  await restarted.init();
  assert.equal(restarted.enabled, true);
  assert.deepEqual(storage.data.get('tabs'), [{ id: 'legacy', autoSave: true }]);
});

test('user enable requests the exact permission before constructing transport', async () => {
  const order = [];
  const storage = createStorage({ tabs: [{ id: 'legacy' }] });
  const permissions = createPermissions();
  permissions.request = async (permission) => {
    order.push(`permission:${permission.origins[0]}`);
    permissions.granted = true;
    return true;
  };
  const client = {
    async load() {
      order.push('load');
      return { document: { title: 'Notes', sections: [] }, revision: 'rev-1', etag: '"rev-1"' };
    },
  };
  const mode = new NotesApiMode({
    storage,
    permissions,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => { order.push('client'); return client; },
    now: () => '2026-10-22T10:00:00Z',
  });

  await mode.enable();

  assert.deepEqual(order, ['permission:https://notes.lab/*', 'client', 'load']);
  assert.equal(mode.state.phase, 'current');
  assert.equal(storage.data.get(API_MODE_STORAGE_KEY), true);
  assert.deepEqual(storage.data.get('tabs'), [{ id: 'legacy' }]);
});

test('switching off clears only API cache/session and leaves legacy state untouched', async () => {
  const storage = createStorage({
    tabs: [{ id: 'legacy', autoSave: true }],
    activeTabId: 'legacy',
    [API_MODE_STORAGE_KEY]: true,
    [API_SESSION_STORAGE_KEY]: { snapshot: { revision: 'rev-1' }, draft: { text: 'draft' } },
  });
  const permissions = createPermissions();
  permissions.granted = true;
  const mode = new NotesApiMode({
    storage,
    permissions,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => ({ load: async () => ({ document: { sections: [] }, revision: 'rev-1' }) }),
  });
  mode.enabled = true;

  await mode.disable();

  assert.equal(storage.data.has(API_MODE_STORAGE_KEY), false);
  assert.equal(storage.data.has(API_SESSION_STORAGE_KEY), false);
  assert.deepEqual(storage.data.get('tabs'), [{ id: 'legacy', autoSave: true }]);
  assert.equal(storage.data.get('activeTabId'), 'legacy');
  assert.equal(permissions.removeCalls, 1);
});

test('restart with an in-flight mutation stays ambiguous and never auto-replays or refreshes it', async () => {
  const pendingMutation = {
    expectedRevision: 'rev-1',
    operationId: 'op-in-flight',
    operation: { type: 'task.create', section_ref: 'section-1', task: { text: 'draft' } },
  };
  const storage = createStorage({
    [API_MODE_STORAGE_KEY]: true,
    [API_SESSION_STORAGE_KEY]: {
      snapshot: { document: { sections: [] }, revision: 'rev-1', fetchedAt: '2026-10-22T10:00:00Z' },
      draft: { text: 'draft' },
      pendingMutation,
    },
  });
  const permissions = createPermissions();
  permissions.granted = true;
  let loads = 0;
  const mode = new NotesApiMode({
    storage,
    permissions,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => ({ load: async () => { loads += 1; throw new Error('must not load'); } }),
  });

  await mode.init();

  assert.equal(mode.state.phase, 'conflict');
  assert.equal(mode.state.conflictReason, 'ambiguous');
  assert.equal(mode.state.pendingMutation.operationId, 'op-in-flight');
  assert.equal(loads, 0);
});

test('ambiguous operation blocks refresh until its stable ID is resolved manually', async () => {
  const storage = createStorage();
  const permissions = createPermissions();
  let loads = 0;
  let sends = 0;
  const client = {
    async load() {
      loads += 1;
      return { document: { sections: [] }, revision: 'rev-1' };
    },
    prepareMutation: () => ({ expectedRevision: 'rev-1', operationId: 'op-1', operation: { type: 'task.create' } }),
    async sendPrepared() {
      sends += 1;
      throw new (await import('../notes-api-client.js')).AmbiguousMutationError({
        expectedRevision: 'rev-1', operationId: 'op-1', operation: { type: 'task.create' },
      });
    },
  };
  const mode = new NotesApiMode({
    storage, permissions, originPermission: { origins: ['https://notes.lab/*'] }, clientFactory: () => client,
  });
  await mode.enable();
  await mode.setDraft({ text: 'draft' });
  await mode.submit({ type: 'task.create' });
  assert.equal(mode.state.phase, 'conflict');
  assert.equal(await mode.refresh(), false);
  assert.equal(loads, 1);
  assert.equal(sends, 1);
  assert.equal(storage.data.get(API_SESSION_STORAGE_KEY).pendingMutation.operationId, 'op-1');
});

test('late GET after disabling API mode cannot restore its cleared session', async () => {
  const storage = createStorage({ tabs: [{ id: 'legacy' }] });
  const permissions = createPermissions();
  let resolveLoad;
  const load = new Promise((resolve) => { resolveLoad = resolve; });
  const mode = new NotesApiMode({
    storage, permissions, originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => ({ load: () => load }),
  });
  const enable = mode.enable();
  await Promise.resolve();
  await Promise.resolve();
  await mode.disable();
  resolveLoad({ document: { sections: [] }, revision: 'late-rev' });
  await enable;

  assert.equal(mode.enabled, false);
  assert.equal(mode.state.confirmed, null);
  assert.equal(storage.data.has(API_SESSION_STORAGE_KEY), false);
  assert.deepEqual(storage.data.get('tabs'), [{ id: 'legacy' }]);
});

test('credential-missing enable waits for explicit pairing, then loads without replaying anything', async () => {
  const storage = createStorage({ tabs: [{ id: 'legacy' }] });
  const permissions = createPermissions();
  let paired = false;
  let clients = 0;
  let loads = 0;
  let sends = 0;
  const auth = {
    async init() {},
    hasCredential: () => paired,
    snapshot: () => ({ phase: paired ? 'current' : 'missing' }),
    async exchange() { paired = true; return this.snapshot(); },
    async rejectCredential() { paired = false; },
    async reset() { paired = false; },
  };
  const mode = new NotesApiMode({
    storage,
    permissions,
    auth,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => {
      clients += 1;
      return {
        async load() {
          loads += 1;
          return { document: { sections: [] }, revision: 'rev-1', etag: '"rev-1"' };
        },
        async sendPrepared() { sends += 1; },
      };
    },
  });

  await mode.enable();
  assert.equal(mode.state.phase, 'auth-required');
  assert.equal(clients, 0);
  assert.equal(loads, 0);

  await mode.pair({ pairingId: 'pairing-id', code: 'code', label: 'Sidepad' });
  assert.equal(mode.state.phase, 'current');
  assert.equal(clients, 1);
  assert.equal(loads, 1);
  assert.equal(sends, 0);
});

test('restart restores a credential and confirmed snapshot without mutation replay', async () => {
  const storedSnapshot = {
    document: { sections: [{ ref: 's1', name: 'Inbox', tasks: [] }] },
    revision: 'rev-1',
    etag: '"rev-1"',
    fetchedAt: '2026-10-24T08:00:00Z',
  };
  const storage = createStorage({
    [API_MODE_STORAGE_KEY]: true,
    [API_SESSION_STORAGE_KEY]: { snapshot: storedSnapshot, draft: { text: 'kept draft' }, pendingMutation: null },
  });
  const permissions = createPermissions();
  permissions.granted = true;
  let loads = 0;
  let sends = 0;
  const auth = {
    async init() {},
    hasCredential: () => true,
    snapshot: () => ({ phase: 'current', credentialId: 'client-id' }),
    async rejectCredential() {},
    async reset() {},
  };
  const mode = new NotesApiMode({
    storage,
    permissions,
    auth,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => ({
      async load({ etag }) {
        loads += 1;
        assert.equal(etag, '"rev-1"');
        return { notModified: true, etag };
      },
      async sendPrepared() { sends += 1; },
    }),
  });

  await mode.init();

  assert.equal(mode.state.phase, 'current');
  assert.equal(mode.state.confirmed.revision, 'rev-1');
  assert.deepEqual(mode.state.draft, { text: 'kept draft' });
  assert.equal(loads, 1);
  assert.equal(sends, 0);
});

for (const status of [401, 403]) {
  test(`mutation ${status} clears rejected auth, preserves the draft and never retries`, async () => {
    const storage = createStorage({ tabs: [] });
    const permissions = createPermissions();
    let rejectedStatus = null;
    let sends = 0;
    const auth = {
      async init() {},
      hasCredential: () => rejectedStatus === null,
      snapshot: () => ({ phase: rejectedStatus === null ? 'current' : 'auth-required' }),
      async rejectCredential(value) { rejectedStatus = value; },
      async reset() { rejectedStatus = null; },
    };
    const client = {
      async load() {
        return { document: { sections: [] }, revision: 'rev-1', etag: '"rev-1"' };
      },
      prepareMutation: () => ({
        expectedRevision: 'rev-1',
        operationId: `op-${status}`,
        operation: { type: 'task.create' },
      }),
      async sendPrepared() {
        sends += 1;
        throw new AuthRequiredError(status);
      },
    };
    const mode = new NotesApiMode({
      storage,
      permissions,
      auth,
      originPermission: { origins: ['https://notes.lab/*'] },
      clientFactory: () => client,
    });
    await mode.enable();
    await mode.setDraft({ text: 'preserve me' });

    assert.equal(await mode.submit({ type: 'task.create' }), false);
    assert.equal(rejectedStatus, status);
    assert.equal(sends, 1);
    assert.equal(mode.state.phase, 'auth-required');
    assert.deepEqual(mode.state.draft, { text: 'preserve me' });
    assert.equal(mode.state.pendingMutation, null);
    assert.equal(storage.data.get(API_SESSION_STORAGE_KEY).pendingMutation, null);
  });
}

test('reset-for-repair deletes only local auth, preserves confirmed state and performs no request', async () => {
  const storage = createStorage({ tabs: [] });
  const permissions = createPermissions();
  let resets = 0;
  let loads = 0;
  const auth = {
    async init() {},
    hasCredential: () => resets === 0,
    snapshot: () => ({ phase: resets === 0 ? 'current' : 'missing' }),
    async reset() { resets += 1; },
    async rejectCredential() {},
  };
  const mode = new NotesApiMode({
    storage,
    permissions,
    auth,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => ({
      async load() {
        loads += 1;
        return { document: { sections: [] }, revision: 'rev-1' };
      },
    }),
  });
  await mode.enable();
  await mode.setDraft({ text: 'keep this' });
  await mode.resetAuth();

  assert.equal(resets, 1);
  assert.equal(loads, 1);
  assert.equal(mode.state.phase, 'auth-required');
  assert.equal(mode.state.confirmed.revision, 'rev-1');
  assert.deepEqual(mode.state.draft, { text: 'keep this' });
});

test('revoked credential on refresh is removed and locks without losing the confirmed snapshot or draft', async () => {
  const storage = createStorage({ tabs: [] });
  const permissions = createPermissions();
  let loads = 0;
  let rejectedStatus = null;
  const auth = {
    async init() {},
    hasCredential: () => rejectedStatus === null,
    snapshot: () => ({ phase: rejectedStatus === null ? 'current' : 'auth-required' }),
    async rejectCredential(status) { rejectedStatus = status; },
    async reset() {},
  };
  const mode = new NotesApiMode({
    storage,
    permissions,
    auth,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => ({
      async load() {
        loads += 1;
        if (loads === 2) throw new AuthRequiredError(401);
        return { document: { sections: [] }, revision: 'rev-1', etag: '"rev-1"' };
      },
    }),
  });
  await mode.enable();
  await mode.setDraft({ text: 'still here' });

  await mode.refresh();

  assert.equal(loads, 2);
  assert.equal(rejectedStatus, 401);
  assert.equal(mode.state.phase, 'auth-required');
  assert.equal(mode.state.confirmed.revision, 'rev-1');
  assert.deepEqual(mode.state.draft, { text: 'still here' });
});

test('re-pairing with an ambiguous mutation restores auth but never replays or refreshes automatically', async () => {
  const storage = createStorage({ tabs: [] });
  const permissions = createPermissions();
  let paired = true;
  let loads = 0;
  let sends = 0;
  const auth = {
    async init() {},
    hasCredential: () => paired,
    snapshot: () => ({ phase: paired ? 'current' : 'missing' }),
    async exchange() { paired = true; },
    async reset() { paired = false; },
    async rejectCredential() { paired = false; },
  };
  const client = {
    async load() {
      loads += 1;
      return { document: { sections: [] }, revision: 'rev-1' };
    },
    prepareMutation: () => ({
      expectedRevision: 'rev-1',
      operationId: 'stable-after-repair',
      operation: { type: 'task.create' },
    }),
    async sendPrepared(mutation) {
      sends += 1;
      throw new (await import('../notes-api-client.js')).AmbiguousMutationError(mutation);
    },
  };
  const mode = new NotesApiMode({
    storage,
    permissions,
    auth,
    originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => client,
  });
  await mode.enable();
  await mode.setDraft({ text: 'uncertain draft' });
  await mode.submit({ type: 'task.create' });
  assert.equal(mode.state.conflictReason, 'ambiguous');
  await mode.resetAuth();

  await mode.pair({ pairingId: 'fresh', code: 'fresh', label: 'Sidepad' });

  assert.equal(mode.state.conflictReason, 'ambiguous');
  assert.equal(mode.state.pendingMutation.operationId, 'stable-after-repair');
  assert.equal(loads, 1);
  assert.equal(sends, 1);
});

function currentMode({ client, storage = createStorage(), auth = null } = {}) {
  const permissions = createPermissions();
  return new NotesApiMode({
    storage, permissions, auth, originPermission: { origins: ['https://notes.lab/*'] }, clientFactory: () => client,
  });
}

test('quiet background refresh keeps the tab writable instead of flashing a loading state', async () => {
  let release;
  let loads = 0;
  const client = {
    load() {
      loads += 1;
      if (loads === 1) return Promise.resolve({ document: { sections: [] }, revision: 'rev-1', etag: '"rev-1"' });
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const mode = currentMode({ client });
  await mode.enable();
  const phases = [];
  mode.subscribe(({ state }) => phases.push(state.phase));
  const pending = mode.refresh({ quiet: true });
  await Promise.resolve();
  assert.equal(mode.state.phase, 'current');
  release({ notModified: true, etag: '"rev-1"' });
  await pending;
  assert.equal(phases.includes('loading'), false);
  assert.equal(mode.state.confirmed.revision, 'rev-1');
});

test('a read that started before a write cannot overwrite the newer write result', async () => {
  let releaseLoad;
  let loads = 0;
  const client = {
    load() {
      loads += 1;
      if (loads === 1) return Promise.resolve({ document: { sections: [] }, revision: 'rev-1' });
      return new Promise((resolve) => { releaseLoad = resolve; });
    },
    prepareMutation: ({ expectedRevision, operation }) => ({ expectedRevision, operationId: 'op-1', operation }),
    sendPrepared: async () => ({ document: { sections: [{ ref: 's', name: 'New', tasks: [] }] }, revision: 'rev-2' }),
  };
  const mode = currentMode({ client });
  await mode.enable();
  const staleRead = mode.refresh({ quiet: true });
  await Promise.resolve();
  assert.equal(await mode.submit({ type: 'section.create', section: { name: 'New' } }), true);
  releaseLoad({ document: { sections: [] }, revision: 'rev-1' });
  await staleRead;
  assert.equal(mode.state.confirmed.revision, 'rev-2');
});

test('a definite rejection records no pending mutation and lets the client reread', async () => {
  const { OperationRejectedError } = await import('../notes-api-client.js');
  let loads = 0;
  const client = {
    load: async () => { loads += 1; return { document: { sections: [] }, revision: `rev-${loads}` }; },
    prepareMutation: ({ expectedRevision, operation }) => ({ expectedRevision, operationId: 'op-1', operation }),
    sendPrepared: async () => { throw new OperationRejectedError(400, 'validation_error'); },
  };
  const mode = currentMode({ client });
  await mode.enable();
  assert.equal(await mode.submit({ type: 'task.delete', task_ref: 'x' }), false);
  assert.equal(mode.state.phase, 'conflict');
  assert.equal(mode.state.conflictReason, 'rejected');
  assert.equal(mode.state.pendingMutation, null);
  assert.equal(await mode.refresh(), true);
  assert.equal(mode.state.phase, 'current');
  assert.equal(loads, 2);
});

test('a credential written by the service worker is picked up without replaying anything', async () => {
  let paired = false;
  let loads = 0;
  let sends = 0;
  const auth = {
    async init() {},
    hasCredential: () => paired,
    snapshot: () => ({ phase: paired ? 'current' : 'missing' }),
    async rejectCredential() { paired = false; },
    async reset() { paired = false; },
  };
  const client = {
    load: async () => { loads += 1; return { document: { sections: [] }, revision: 'rev-1' }; },
    sendPrepared: async () => { sends += 1; },
  };
  const mode = currentMode({ client, auth });
  await mode.enable();
  assert.equal(mode.state.phase, 'auth-required');
  assert.equal(await mode.reloadAuth(), false);
  paired = true;
  assert.equal(await mode.reloadAuth(), true);
  assert.equal(mode.state.phase, 'current');
  assert.equal(loads, 1);
  assert.equal(sends, 0);
});
