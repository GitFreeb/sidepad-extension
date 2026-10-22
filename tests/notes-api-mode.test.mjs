import test from 'node:test';
import assert from 'node:assert/strict';

import { NotesApiMode, API_MODE_STORAGE_KEY, API_SESSION_STORAGE_KEY } from '../notes-api-mode.js';

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

test('active legacy file autosave blocks API activation before permission or transport', async () => {
  const storage = createStorage({ tabs: [{ id: 'legacy', autoSave: true }] });
  const permissions = createPermissions();
  let clients = 0;
  const mode = new NotesApiMode({
    storage, permissions, originPermission: { origins: ['https://notes.lab/*'] },
    clientFactory: () => { clients += 1; return {}; },
  });

  assert.equal(await mode.enable(), false);
  assert.equal(mode.lastEnableReason, 'legacy-auto-save');
  assert.equal(permissions.requestCalls, 0);
  assert.equal(clients, 0);
  assert.equal(storage.data.has(API_MODE_STORAGE_KEY), false);
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
