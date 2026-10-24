export const NOTES_ORIGIN = 'https://notes.lab';
export const API_CREDENTIAL_STORAGE_KEY = 'notesApiCredentialV1';

const EXCHANGE_PATH = '/api/auth/pairings/exchange';
const REQUIRED_SCOPES = Object.freeze(['document:read', 'document:write']);
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CREDENTIAL_PATTERN = new RegExp(`^nlc_(${UUID_PATTERN})\\.([A-Za-z0-9_-]{16,})$`, 'i');

export class PairingError extends Error {
  constructor(reason, status = null, options = {}) {
    super('Sidepad pairing could not be completed.', options);
    this.name = 'PairingError';
    this.reason = reason;
    this.status = status;
  }
}

function exactScopes(scopes) {
  return Array.isArray(scopes)
    && scopes.length === REQUIRED_SCOPES.length
    && REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
}

function validCurrentRecord(record) {
  if (!record || record.version !== 1 || record.status !== 'current') return false;
  const match = typeof record.credential === 'string' ? record.credential.match(CREDENTIAL_PATTERN) : null;
  return Boolean(
    match
    && match[1].toLowerCase() === String(record.credentialId || '').toLowerCase()
    && exactScopes(record.scopes)
    && typeof record.pairedAt === 'string',
  );
}

function validLockedRecord(record) {
  return Boolean(
    record
    && record.version === 1
    && record.status === 'auth-required'
    && !Object.prototype.hasOwnProperty.call(record, 'credential')
    && typeof record.rejectedAt === 'string'
    && (record.statusCode === 401 || record.statusCode === 403),
  );
}

function metadata(record) {
  if (!record) return {};
  return {
    credentialId: typeof record.credentialId === 'string' ? record.credentialId : null,
    scopes: exactScopes(record.scopes) ? [...record.scopes] : [],
    pairedAt: typeof record.pairedAt === 'string' ? record.pairedAt : null,
  };
}

function pairingFailureReason(status) {
  if (status === 400) return 'invalid-input';
  if (status === 401) return 'invalid-or-expired';
  if (status === 403) return 'origin-forbidden';
  return 'service-unavailable';
}

function validPairingInput({ pairingId, code, label } = {}) {
  return typeof pairingId === 'string'
    && pairingId.trim() === pairingId
    && pairingId.length > 0
    && typeof code === 'string'
    && code.length > 0
    && typeof label === 'string'
    && label.trim() === label
    && label.length > 0
    && label.length <= 80;
}

export class NotesApiAuth {
  constructor({ storage, fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
    if (!storage?.get || !storage?.set || !storage?.remove) {
      throw new TypeError('A local storage adapter is required.');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.phase = 'missing';
    this.record = null;
    this.errorReason = null;
  }

  snapshot() {
    return Object.freeze({
      phase: this.phase,
      ...metadata(this.record),
      errorReason: this.errorReason,
    });
  }

  hasCredential() {
    return this.phase === 'current' && validCurrentRecord(this.record);
  }

  async init() {
    const stored = await this.storage.get([API_CREDENTIAL_STORAGE_KEY]);
    const record = stored[API_CREDENTIAL_STORAGE_KEY];
    this.errorReason = null;
    if (validCurrentRecord(record)) {
      this.record = record;
      this.phase = 'current';
    } else if (validLockedRecord(record)) {
      this.record = record;
      this.phase = 'auth-required';
    } else {
      this.record = null;
      this.phase = 'missing';
      if (record !== undefined) await this.storage.remove([API_CREDENTIAL_STORAGE_KEY]);
    }
    return this.snapshot();
  }

  async exchange(input) {
    this.phase = 'pairing';
    this.errorReason = null;
    if (!validPairingInput(input)) {
      this.phase = 'missing';
      this.errorReason = 'invalid-input';
      throw new PairingError('invalid-input');
    }

    let response;
    try {
      response = await this.fetchImpl(`${NOTES_ORIGIN}${EXCHANGE_PATH}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairing_id: input.pairingId,
          code: input.code,
          label: input.label,
        }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    } catch (cause) {
      this.phase = 'missing';
      this.errorReason = 'offline';
      throw new PairingError('offline', null, { cause });
    }

    if (!response.ok) {
      const reason = pairingFailureReason(response.status);
      this.phase = 'missing';
      this.errorReason = reason;
      throw new PairingError(reason, response.status);
    }

    let result;
    try {
      result = await response.json();
    } catch (cause) {
      this.phase = 'missing';
      this.errorReason = 'invalid-response';
      throw new PairingError('invalid-response', response.status, { cause });
    }

    const record = {
      version: 1,
      status: 'current',
      credentialId: result?.credential_id,
      credential: result?.credential,
      scopes: result?.scopes,
      pairedAt: this.now(),
    };
    if (!validCurrentRecord(record)) {
      this.phase = 'missing';
      this.errorReason = 'invalid-response';
      throw new PairingError('invalid-response', response.status);
    }

    try {
      await this.storage.set({ [API_CREDENTIAL_STORAGE_KEY]: record });
    } catch (cause) {
      this.phase = 'missing';
      this.errorReason = 'storage-failed';
      throw new PairingError('storage-failed', null, { cause });
    }
    this.record = record;
    this.phase = 'current';
    this.errorReason = null;
    return this.snapshot();
  }

  async authorizeContentRequest(init, context = {}) {
    if (!this.hasCredential() || context.resource !== 'content') return init;
    let url;
    try {
      url = new URL(context.url);
    } catch {
      return init;
    }
    if (url.origin !== NOTES_ORIGIN || !url.pathname.startsWith('/api/v1/')) return init;

    let headers;
    if (init.headers instanceof Headers) {
      headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${this.record.credential}`);
    } else {
      headers = { ...(init.headers || {}), Authorization: `Bearer ${this.record.credential}` };
    }
    return { ...init, headers };
  }

  async rejectCredential(status) {
    if (status !== 401 && status !== 403) throw new TypeError('Rejected credential status must be 401 or 403.');
    const previous = metadata(this.record);
    const locked = {
      version: 1,
      status: 'auth-required',
      credentialId: previous.credentialId,
      scopes: previous.scopes,
      pairedAt: previous.pairedAt,
      rejectedAt: this.now(),
      statusCode: status,
    };
    this.record = locked;
    this.phase = 'auth-required';
    this.errorReason = 'credential-rejected';
    await this.storage.set({ [API_CREDENTIAL_STORAGE_KEY]: locked });
    return this.snapshot();
  }

  async reset() {
    this.record = null;
    this.phase = 'missing';
    this.errorReason = null;
    await this.storage.remove([API_CREDENTIAL_STORAGE_KEY]);
    return this.snapshot();
  }
}
