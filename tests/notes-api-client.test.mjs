import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AmbiguousMutationError,
  AuthRequiredError,
  OfflineError,
  RevisionConflictError,
  RevisionedNotesClient,
  createFetchTransport,
} from '../notes-api-client.js';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const documentV1 = {
  title: 'Notes',
  sections: [{ ref: 'section-1', name: 'Inbox', tasks: [] }],
};

test('GET 200 returns the confirmed document, revision and ETag', async () => {
  const requests = [];
  const client = new RevisionedNotesClient({
    transport: {
      request: async (request) => {
        requests.push(request);
        return jsonResponse({ document: documentV1, revision: 'rev-1' }, 200, { ETag: '"rev-1"' });
      },
    },
  });

  const result = await client.load();

  assert.equal(requests[0].path, '/api/v1/document');
  assert.equal(requests[0].method, 'GET');
  assert.equal(result.revision, 'rev-1');
  assert.equal(result.etag, '"rev-1"');
  assert.deepEqual(result.document, documentV1);
});

test('conditional GET sends If-None-Match and accepts 304', async () => {
  let request;
  const client = new RevisionedNotesClient({
    transport: {
      request: async (value) => {
        request = value;
        return new Response(null, { status: 304, headers: { ETag: '"rev-1"' } });
      },
    },
  });

  const result = await client.load({ etag: '"rev-1"' });

  assert.equal(request.headers['If-None-Match'], '"rev-1"');
  assert.deepEqual(result, { notModified: true, etag: '"rev-1"' });
});

for (const status of [401, 403]) {
  test(`GET ${status} locks the client without reading a payload`, async () => {
    const client = new RevisionedNotesClient({
      transport: { request: async () => new Response(null, { status }) },
    });
    await assert.rejects(client.load(), (error) => {
      assert.ok(error instanceof AuthRequiredError);
      assert.equal(error.status, status);
      return true;
    });
  });

  test(`mutation ${status} locks the client without inspecting a payload`, async () => {
    const client = new RevisionedNotesClient({
      operationIdFactory: () => `op-${status}`,
      transport: { request: async () => new Response(null, { status }) },
    });
    await assert.rejects(
      client.mutate({ expectedRevision: 'rev-1', operation: { type: 'task.toggle', task_ref: 'task-1', done: true } }),
      (error) => error instanceof AuthRequiredError && error.status === status,
    );
  });
}

test('GET network failure becomes offline', async () => {
  const client = new RevisionedNotesClient({
    transport: { request: async () => { throw new TypeError('network down'); } },
  });
  await assert.rejects(client.load(), OfflineError);
});

test('GET 503 keeps the confirmed snapshot in offline read-only mode', async () => {
  const client = new RevisionedNotesClient({
    transport: { request: async () => new Response(null, { status: 503 }) },
  });
  await assert.rejects(client.load(), OfflineError);
});

test('409 exposes the current revision and never retries automatically', async () => {
  let attempts = 0;
  const client = new RevisionedNotesClient({
    operationIdFactory: () => 'op-conflict',
    transport: {
      request: async () => {
        attempts += 1;
        return jsonResponse({ current_revision: 'rev-2' }, 409);
      },
    },
  });

  await assert.rejects(
    client.mutate({
      expectedRevision: 'rev-1',
      operation: { type: 'task.create', section_ref: 'section-1', task: { text: 'Draft' } },
    }),
    (error) => error instanceof RevisionConflictError && error.currentRevision === 'rev-2',
  );
  assert.equal(attempts, 1);
});

test('manual retry after a lost mutation response reuses the operation ID', async () => {
  const requests = [];
  let attempt = 0;
  const client = new RevisionedNotesClient({
    operationIdFactory: () => 'op-stable',
    transport: {
      request: async (request) => {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) throw new TypeError('response lost');
        return jsonResponse({ document: documentV1, revision: 'rev-2' }, 200, { ETag: '"rev-2"' });
      },
    },
  });

  let ambiguous;
  try {
    await client.mutate({
      expectedRevision: 'rev-1',
      operation: { type: 'task.create', section_ref: 'section-1', task: { text: 'Draft' } },
    });
  } catch (error) {
    ambiguous = error;
  }

  assert.ok(ambiguous instanceof AmbiguousMutationError);
  const result = await client.retry(ambiguous);
  assert.equal(result.revision, 'rev-2');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.operation_id, 'op-stable');
  assert.equal(requests[1].body.operation_id, 'op-stable');
  assert.deepEqual(requests[1].body, requests[0].body);
});

test('a server error or malformed success after mutation is ambiguous', async () => {
  for (const response of [
    new Response(null, { status: 503 }),
    jsonResponse({ message: 'missing revision' }),
  ]) {
    const client = new RevisionedNotesClient({
      operationIdFactory: () => 'op-uncertain',
      transport: { request: async () => response },
    });
    await assert.rejects(
      client.mutate({ expectedRevision: 'rev-1', operation: { type: 'task.toggle', task_ref: 'task-1', done: true } }),
      (error) => error instanceof AmbiguousMutationError && error.mutation.operationId === 'op-uncertain',
    );
  }
});

test('mutations send semantic operations, not a full Markdown document', async () => {
  const client = new RevisionedNotesClient({
    operationIdFactory: () => 'op-1',
    transport: { request: async () => jsonResponse({ document: documentV1, revision: 'rev-2' }) },
  });

  const result = await client.mutate({
    expectedRevision: 'rev-1',
    operation: { type: 'task.toggle', task_ref: 'task-1', done: true },
  });
  assert.equal(result.revision, 'rev-2');
  assert.throws(() => client.prepareMutation({
    expectedRevision: 'rev-2',
    operation: { type: 'replace', markdown: '# Notes' },
  }), /not allowed/);
});

test('fetch transport gives the authorizer exact request metadata and refuses cross-origin paths', async () => {
  const authorizations = [];
  const requests = [];
  const transport = createFetchTransport({
    baseUrl: 'https://notes.lab',
    authorize: async (init, context) => {
      authorizations.push(context);
      return init;
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  await transport.request({ path: '/api/v1/document', method: 'GET' });

  assert.deepEqual(authorizations, [{
    resource: 'content',
    url: 'https://notes.lab/api/v1/document',
  }]);
  assert.equal(requests[0].url, 'https://notes.lab/api/v1/document');
  assert.equal(requests[0].init.redirect, 'error');
  await assert.rejects(
    transport.request({ path: 'https://example.com/api/v1/document', method: 'GET' }),
    /cross-origin/i,
  );
  assert.equal(requests.length, 1);
});
