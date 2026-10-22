const DOCUMENT_PATH = '/api/v1/document';
const OPERATIONS_PATH = '/api/v1/document/operations';

export class NotesApiError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthRequiredError extends NotesApiError {
  constructor(status) {
    super('Notes API authentication is required.');
    this.status = status;
  }
}

export class RevisionConflictError extends NotesApiError {
  constructor(currentRevision) {
    super('The document revision changed before the operation was applied.');
    this.currentRevision = currentRevision || null;
  }
}

export class OfflineError extends NotesApiError {
  constructor(options = {}) {
    super('The Notes API is unavailable.', options);
  }
}

export class AmbiguousMutationError extends NotesApiError {
  constructor(mutation, options = {}) {
    super('The operation response was lost; the server result is unknown.', options);
    this.mutation = mutation;
  }
}

export class ProtocolError extends NotesApiError {}

function responseHeader(response, name) {
  return response.headers?.get?.(name) || null;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (cause) {
    throw new ProtocolError('The Notes API returned invalid JSON.', { cause });
  }
}

function validateVersionedDocument(data) {
  if (!data || typeof data !== 'object' || typeof data.revision !== 'string' || !data.document) {
    throw new ProtocolError('The Notes API response is missing a document or revision.');
  }
  return data;
}

function containsFullDocumentPayload(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsFullDocumentPayload);
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (normalized === 'document' || normalized === 'markdown' || normalized === 'fulldocument') return true;
    return containsFullDocumentPayload(child);
  });
}

function validateSemanticOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new TypeError('A semantic operation object is required.');
  }
  if (typeof operation.type !== 'string' || operation.type.trim() === '') {
    throw new TypeError('A semantic operation type is required.');
  }
  if (containsFullDocumentPayload(operation)) {
    throw new TypeError('Full document or Markdown payloads are not allowed.');
  }
}

function defaultOperationId() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('crypto.randomUUID is required to create operation IDs.');
  }
  return globalThis.crypto.randomUUID();
}

export function createFetchTransport({ baseUrl, fetchImpl = globalThis.fetch, authorize } = {}) {
  if (!baseUrl) throw new TypeError('baseUrl is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');

  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  return {
    async request({ path, method, headers = {}, body }) {
      let init = {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      };
      if (authorize) init = await authorize(init);
      return fetchImpl(`${normalizedBaseUrl}${path}`, init);
    },
  };
}

export class RevisionedNotesClient {
  constructor({ transport, operationIdFactory = defaultOperationId } = {}) {
    if (!transport?.request) throw new TypeError('An injected transport is required.');
    this.transport = transport;
    this.operationIdFactory = operationIdFactory;
  }

  async load({ etag } = {}) {
    const headers = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;

    let response;
    try {
      response = await this.transport.request({ path: DOCUMENT_PATH, method: 'GET', headers });
    } catch (cause) {
      throw new OfflineError({ cause });
    }

    if (response.status === 304) {
      return { notModified: true, etag: responseHeader(response, 'ETag') || etag || null };
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError(response.status);
    }
    if (response.status === 503 || response.status === 502 || response.status === 504) {
      throw new OfflineError();
    }
    if (!response.ok) throw new ProtocolError(`The Notes API returned HTTP ${response.status}.`);

    const data = validateVersionedDocument(await readJson(response));
    return {
      notModified: false,
      document: data.document,
      revision: data.revision,
      etag: responseHeader(response, 'ETag'),
    };
  }

  prepareMutation({ expectedRevision, operation, operationId } = {}) {
    if (typeof expectedRevision !== 'string' || expectedRevision === '') {
      throw new TypeError('expectedRevision is required.');
    }
    validateSemanticOperation(operation);
    const stableOperationId = operationId || this.operationIdFactory();
    if (typeof stableOperationId !== 'string' || stableOperationId === '') {
      throw new TypeError('operationId must be a non-empty string.');
    }
    return Object.freeze({
      expectedRevision,
      operationId: stableOperationId,
      operation: structuredClone(operation),
    });
  }

  async mutate(options) {
    return this.sendPrepared(this.prepareMutation(options));
  }

  async retry(ambiguousError) {
    if (!(ambiguousError instanceof AmbiguousMutationError)) {
      throw new TypeError('retry requires an AmbiguousMutationError.');
    }
    return this.sendPrepared(ambiguousError.mutation);
  }

  async sendPrepared(mutation) {
    const body = {
      expected_revision: mutation.expectedRevision,
      operation_id: mutation.operationId,
      operation: mutation.operation,
    };
    let response;
    try {
      response = await this.transport.request({
        path: OPERATIONS_PATH,
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body,
      });
    } catch (cause) {
      throw new AmbiguousMutationError(mutation, { cause });
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError(response.status);
    }
    try {
      if (response.status === 409) {
        const data = await readJson(response);
        throw new RevisionConflictError(data.current_revision);
      }
      if (!response.ok) throw new ProtocolError(`The Notes API returned HTTP ${response.status}.`);

      const data = validateVersionedDocument(await readJson(response));
      return {
        document: data.document,
        revision: data.revision,
        etag: responseHeader(response, 'ETag'),
      };
    } catch (cause) {
      if (cause instanceof RevisionConflictError) throw cause;
      throw new AmbiguousMutationError(mutation, { cause });
    }
  }
}
