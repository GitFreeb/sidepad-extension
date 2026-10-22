import test from 'node:test';
import assert from 'node:assert/strict';

import { API_PHASES, canMutate, createApiState, reduceApiState } from '../notes-api-state.js';

const snapshot = {
  document: { title: 'Notes', sections: [] },
  revision: 'rev-1',
  etag: '"rev-1"',
  fetchedAt: '2026-10-22T10:00:00Z',
};

test('state machine covers loading, current and saving', () => {
  let state = createApiState();
  assert.equal(state.phase, API_PHASES.LOADING);

  state = reduceApiState(state, { type: 'LOAD_SUCCESS', snapshot });
  assert.equal(state.phase, API_PHASES.CURRENT);
  assert.equal(canMutate(state), true);

  state = reduceApiState(state, { type: 'DRAFT_CHANGED', draft: { text: 'local input' } });
  state = reduceApiState(state, { type: 'SAVE_START', mutation: { operationId: 'op-1' } });
  assert.equal(state.phase, API_PHASES.SAVING);
  assert.equal(state.draft.text, 'local input');
});

test('409 enters explicit conflict state and preserves local input', () => {
  let state = createApiState({ snapshot, draft: { text: 'unsaved' } });
  state = reduceApiState(state, { type: 'LOAD_SUCCESS', snapshot });
  state = reduceApiState(state, { type: 'SAVE_START', mutation: { operationId: 'op-1' } });
  state = reduceApiState(state, { type: 'SAVE_CONFLICT', currentRevision: 'rev-2' });

  assert.equal(state.phase, API_PHASES.CONFLICT);
  assert.equal(state.conflictReason, 'revision');
  assert.equal(state.currentRevision, 'rev-2');
  assert.deepEqual(state.draft, { text: 'unsaved' });
  assert.equal(canMutate(state), false);
});

test('lost response retains the exact pending mutation for manual retry', () => {
  const mutation = { expectedRevision: 'rev-1', operationId: 'stable-op', operation: { type: 'task.toggle' } };
  let state = createApiState({ snapshot, draft: { text: 'unsaved' } });
  state = reduceApiState(state, { type: 'SAVE_AMBIGUOUS', mutation });

  assert.equal(state.phase, API_PHASES.CONFLICT);
  assert.equal(state.conflictReason, 'ambiguous');
  assert.equal(state.pendingMutation, mutation);
  assert.deepEqual(state.draft, { text: 'unsaved' });
});

test('network loss is read-only and cannot create or change a draft', () => {
  const originalDraft = { text: 'started online' };
  let state = createApiState({ snapshot, draft: originalDraft });
  state = reduceApiState(state, { type: 'LOAD_OFFLINE' });
  const afterEdit = reduceApiState(state, { type: 'DRAFT_CHANGED', draft: { text: 'offline edit' } });
  const afterSave = reduceApiState(state, { type: 'SAVE_START', mutation: { operationId: 'queued' } });

  assert.equal(state.phase, API_PHASES.OFFLINE_READ_ONLY);
  assert.equal(canMutate(state), false);
  assert.equal(afterEdit, state);
  assert.equal(afterSave, state);
  assert.equal(state.draft, originalDraft);
});

test('401/403 state is locked and reset clears snapshot, draft and pending operation', () => {
  let state = createApiState({ snapshot, draft: { text: 'private' }, pendingMutation: { operationId: 'op-1' } });
  state = reduceApiState(state, { type: 'AUTH_REQUIRED' });
  assert.equal(state.phase, API_PHASES.AUTH_REQUIRED);
  assert.equal(canMutate(state), false);

  state = reduceApiState(state, { type: 'RESET' });
  assert.equal(state.phase, API_PHASES.LOADING);
  assert.equal(state.confirmed, null);
  assert.equal(state.draft, null);
  assert.equal(state.pendingMutation, null);
});
