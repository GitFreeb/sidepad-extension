import {
  AmbiguousMutationError,
  AuthRequiredError,
  OfflineError,
  RevisionConflictError,
} from './notes-api-client.js';
import { createApiState, reduceApiState, canMutate } from './notes-api-state.js';

export const API_MODE_STORAGE_KEY = 'notesApiExperimentalModeV1';
export const API_SESSION_STORAGE_KEY = 'notesApiSessionV1';

function savedSession(state) {
  return {
    snapshot: state.confirmed,
    draft: state.draft,
    pendingMutation:
      state.phase === 'saving' || state.conflictReason === 'ambiguous'
        ? state.pendingMutation
        : null,
  };
}

export class NotesApiMode {
  constructor({ storage, permissions, clientFactory, originPermission, now = () => new Date().toISOString() }) {
    this.storage = storage;
    this.permissions = permissions;
    this.clientFactory = clientFactory;
    this.originPermission = originPermission;
    this.now = now;
    this.enabled = false;
    this.client = null;
    this.state = createApiState();
    this.listeners = new Set();
    this.epoch = 0;
    this.loading = false;
    this.storageQueue = Promise.resolve();
    this.lastEnableReason = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return { enabled: this.enabled, state: this.state };
  }

  emit() {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  async init() {
    const stored = await this.storage.get([API_MODE_STORAGE_KEY, API_SESSION_STORAGE_KEY, 'tabs']);
    if (stored[API_MODE_STORAGE_KEY] !== true) {
      this.emit();
      return;
    }
    if (stored.tabs?.some((tab) => tab.autoSave)) {
      await this.clearApiStorage();
      await this.permissions.remove(this.originPermission);
      this.emit();
      return;
    }
    if (!(await this.permissions.contains(this.originPermission))) {
      await this.clearApiStorage();
      this.emit();
      return;
    }
    const session = stored[API_SESSION_STORAGE_KEY] || {};
    this.state = createApiState(session);
    if (session.pendingMutation) {
      this.state = {
        ...this.state,
        phase: 'conflict',
        conflictReason: 'ambiguous',
      };
    }
    this.enabled = true;
    this.epoch += 1;
    this.client = this.clientFactory();
    this.emit();
    if (session.pendingMutation) return;
    await this.refresh();
  }

  async enable() {
    if (this.enabled) return true;
    const legacy = await this.storage.get(['tabs']);
    if (legacy.tabs?.some((tab) => tab.autoSave)) {
      this.lastEnableReason = 'legacy-auto-save';
      return false;
    }
    this.lastEnableReason = null;
    const granted = await this.permissions.request(this.originPermission);
    if (!granted) {
      this.lastEnableReason = 'permission-denied';
      return false;
    }
    this.enabled = true;
    this.epoch += 1;
    this.client = this.clientFactory();
    this.state = createApiState();
    await this.storage.set({ [API_MODE_STORAGE_KEY]: true });
    this.emit();
    await this.refresh();
    return true;
  }

  async disable() {
    this.enabled = false;
    this.epoch += 1;
    this.loading = false;
    this.client = null;
    this.state = createApiState();
    await this.storageQueue.catch(() => {});
    await this.clearApiStorage();
    await this.permissions.remove(this.originPermission);
    this.emit();
  }

  async clearApiStorage() {
    await this.storage.remove([API_MODE_STORAGE_KEY, API_SESSION_STORAGE_KEY]);
  }

  async persistSession() {
    if (!this.enabled) return;
    const epoch = this.epoch;
    const session = savedSession(this.state);
    this.storageQueue = this.storageQueue.catch(() => {}).then(() => {
      if (this.enabled && this.epoch === epoch) {
        return this.storage.set({ [API_SESSION_STORAGE_KEY]: session });
      }
    });
    await this.storageQueue;
  }

  async refresh() {
    if (!this.enabled || !this.client || this.loading || this.state.phase === 'saving' || this.state.pendingMutation) return false;
    const epoch = this.epoch;
    const client = this.client;
    this.loading = true;
    this.state = reduceApiState(this.state, { type: 'LOAD_START' });
    this.emit();
    try {
      const result = await client.load({ etag: this.state.confirmed?.etag });
      if (this.epoch !== epoch) return false;
      if (result.notModified) {
        this.state = reduceApiState(this.state, {
          type: 'LOAD_NOT_MODIFIED',
          fetchedAt: this.now(),
          etag: result.etag,
        });
      } else {
        this.state = reduceApiState(this.state, {
          type: 'LOAD_SUCCESS',
          snapshot: {
            document: result.document,
            revision: result.revision,
            etag: result.etag,
            fetchedAt: this.now(),
          },
        });
      }
    } catch (error) {
      if (this.epoch !== epoch) return false;
      if (error instanceof AuthRequiredError) {
        this.state = reduceApiState(this.state, { type: 'AUTH_REQUIRED' });
      } else if (error instanceof OfflineError) {
        this.state = reduceApiState(this.state, { type: 'LOAD_OFFLINE' });
      } else {
        throw error;
      }
    } finally {
      if (this.epoch === epoch) this.loading = false;
    }
    if (this.epoch !== epoch) return false;
    await this.persistSession();
    if (this.epoch !== epoch) return false;
    this.emit();
    return true;
  }

  async setDraft(draft) {
    this.state = reduceApiState(this.state, { type: 'DRAFT_CHANGED', draft });
    await this.persistSession();
    this.emit();
  }

  async submit(operation) {
    if (!canMutate(this.state)) return false;
    const mutation = this.client.prepareMutation({
      expectedRevision: this.state.confirmed.revision,
      operation,
    });
    return this.sendMutation(mutation);
  }

  async retryAmbiguous() {
    if (this.state.conflictReason !== 'ambiguous' || !this.state.pendingMutation) return false;
    return this.sendMutation(this.state.pendingMutation);
  }

  async sendMutation(mutation) {
    const isCurrentWrite = this.state.phase === 'current';
    const isExactAmbiguousRetry =
      this.state.phase === 'conflict' &&
      this.state.conflictReason === 'ambiguous' &&
      this.state.pendingMutation?.operationId === mutation.operationId;
    if (!isCurrentWrite && !isExactAmbiguousRetry) return false;

    const epoch = this.epoch;
    const client = this.client;
    const priorState = this.state;
    this.state = { ...this.state, phase: 'current' };
    this.state = reduceApiState(this.state, { type: 'SAVE_START', mutation });
    await this.persistSession();
    if (this.epoch !== epoch) return false;
    this.emit();
    try {
      const result = await client.sendPrepared(mutation);
      if (this.epoch !== epoch) return false;
      this.state = reduceApiState(this.state, {
        type: 'SAVE_SUCCESS',
        snapshot: {
          document: result.document,
          revision: result.revision,
          etag: result.etag,
          fetchedAt: this.now(),
        },
      });
    } catch (error) {
      if (this.epoch !== epoch) return false;
      if (error instanceof RevisionConflictError) {
        this.state = reduceApiState({ ...priorState, pendingMutation: mutation }, {
          type: 'SAVE_CONFLICT',
          currentRevision: error.currentRevision,
        });
      } else if (error instanceof AmbiguousMutationError) {
        this.state = reduceApiState(priorState, { type: 'SAVE_AMBIGUOUS', mutation: error.mutation });
      } else if (error instanceof AuthRequiredError) {
        this.state = reduceApiState(priorState, { type: 'AUTH_REQUIRED' });
      } else {
        throw error;
      }
    }
    if (this.epoch !== epoch) return false;
    await this.persistSession();
    if (this.epoch !== epoch) return false;
    this.emit();
    return this.state.phase === 'current';
  }
}
