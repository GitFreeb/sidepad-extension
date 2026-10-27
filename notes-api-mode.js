import {
  AmbiguousMutationError,
  AuthRequiredError,
  OfflineError,
  OperationRejectedError,
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

const OFFLINE_AFTER_QUIET_FAILURES = 2;

export class NotesApiMode {
  constructor({ storage, permissions, clientFactory, originPermission, auth = null, now = () => new Date().toISOString() }) {
    this.storage = storage;
    this.permissions = permissions;
    this.clientFactory = clientFactory;
    this.originPermission = originPermission;
    this.auth = auth;
    this.now = now;
    this.enabled = false;
    this.client = null;
    this.state = createApiState();
    this.listeners = new Set();
    this.epoch = 0;
    this.loading = false;
    this.storageQueue = Promise.resolve();
    this.lastEnableReason = null;
    // Растёт при каждой отправке мутации: чтение, начатое раньше записи,
    // не должно перезаписать более новый результат этой записи.
    this.writeSeq = 0;
    // Один сбой фонового опроса — ещё не офлайн: при коротком обрыве сети
    // вкладка иначе мигает между «офлайн» и «✓».
    this.quietFailures = 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      auth: this.auth?.snapshot?.() || null,
    };
  }

  emit() {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  async init() {
    const stored = await this.storage.get([API_MODE_STORAGE_KEY, API_SESSION_STORAGE_KEY]);
    if (stored[API_MODE_STORAGE_KEY] !== true) {
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
    if (this.auth) await this.auth.init();
    if (this.auth && !this.auth.hasCredential()) {
      if (!session.pendingMutation) {
        this.state = reduceApiState(this.state, { type: 'AUTH_REQUIRED' });
      }
      await this.persistSession();
      this.emit();
      return;
    }
    this.client = this.clientFactory();
    this.emit();
    if (session.pendingMutation) return;
    await this.refresh();
  }

  async enable() {
    if (this.enabled) return true;
    this.lastEnableReason = null;
    const granted = await this.permissions.request(this.originPermission);
    if (!granted) {
      this.lastEnableReason = 'permission-denied';
      return false;
    }
    this.enabled = true;
    this.epoch += 1;
    this.state = createApiState();
    await this.storage.set({ [API_MODE_STORAGE_KEY]: true });
    if (this.auth) await this.auth.init();
    if (this.auth && !this.auth.hasCredential()) {
      this.client = null;
      this.state = reduceApiState(this.state, { type: 'AUTH_REQUIRED' });
      await this.persistSession();
      this.emit();
      return true;
    }
    this.client = this.clientFactory();
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

  async refresh({ quiet = false } = {}) {
    if (!this.enabled || !this.client || this.loading || this.state.phase === 'saving' || this.state.pendingMutation) return false;
    const epoch = this.epoch;
    const client = this.client;
    const writeSeq = this.writeSeq;
    this.loading = true;
    if (!quiet) {
      this.state = reduceApiState(this.state, { type: 'LOAD_START' });
      this.emit();
    }
    try {
      const result = await client.load({ etag: this.state.confirmed?.etag });
      if (this.epoch !== epoch) return false;
      if (this.writeSeq !== writeSeq) return false;
      this.quietFailures = 0;
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
      if (this.writeSeq !== writeSeq) return false;
      if (error instanceof AuthRequiredError) {
        await this.rejectAuth(error.status);
        this.state = reduceApiState(this.state, { type: 'AUTH_REQUIRED' });
      } else if (error instanceof OfflineError) {
        this.quietFailures = quiet ? this.quietFailures + 1 : 0;
        if (quiet && this.state.phase === 'current' && this.quietFailures < OFFLINE_AFTER_QUIET_FAILURES) return false;
        this.quietFailures = 0;
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

  async pair(pairing) {
    if (!this.enabled || !this.auth) return false;
    const epoch = this.epoch;
    const exchange = this.auth.exchange(pairing);
    this.emit();
    try {
      await exchange;
    } catch (error) {
      if (this.epoch === epoch) this.emit();
      throw error;
    }
    if (this.epoch !== epoch || !this.auth.hasCredential()) return false;
    this.client = this.clientFactory();
    if (this.state.conflictReason === 'ambiguous' && this.state.pendingMutation) {
      await this.persistSession();
      if (this.epoch === epoch) this.emit();
      return this.epoch === epoch;
    }
    this.state = reduceApiState(this.state, { type: 'AUTH_RECOVERY_START' });
    await this.persistSession();
    if (this.epoch !== epoch) return false;
    this.emit();
    return this.refresh();
  }

  // Credential записывает service worker после автоподключения из web.
  async reloadAuth() {
    if (!this.enabled || !this.auth) return false;
    const epoch = this.epoch;
    await this.auth.init();
    if (this.epoch !== epoch) return false;
    if (!this.auth.hasCredential()) {
      this.client = null;
      this.emit();
      return false;
    }
    if (this.client) return true;
    this.client = this.clientFactory();
    if (this.state.conflictReason === 'ambiguous' && this.state.pendingMutation) {
      this.emit();
      return true;
    }
    this.state = reduceApiState(this.state, { type: 'AUTH_RECOVERY_START' });
    await this.persistSession();
    if (this.epoch !== epoch) return false;
    this.emit();
    return this.refresh();
  }

  async resetAuth() {
    if (!this.enabled || !this.auth) return false;
    this.epoch += 1;
    this.loading = false;
    this.client = null;
    await this.auth.reset();
    if (!(this.state.conflictReason === 'ambiguous' && this.state.pendingMutation)) {
      this.state = reduceApiState(this.state, { type: 'AUTH_REQUIRED' });
    }
    await this.persistSession();
    this.emit();
    return true;
  }

  async rejectAuth(status) {
    this.client = null;
    if (!this.auth) return;
    try {
      await this.auth.rejectCredential(status);
    } catch {
      // The in-memory secret is already gone; keep the client locked even if persistence failed.
    }
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
    this.writeSeq += 1;
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
      } else if (error instanceof OperationRejectedError) {
        this.state = reduceApiState(priorState, { type: 'SAVE_REJECTED' });
      } else if (error instanceof AmbiguousMutationError) {
        this.state = reduceApiState(priorState, { type: 'SAVE_AMBIGUOUS', mutation: error.mutation });
      } else if (error instanceof AuthRequiredError) {
        await this.rejectAuth(error.status);
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
