// Синтетический Notes API для browser-тестов. Повторяет контракт
// notes-lab/docs/contracts/http-api.md в объёме, который использует Sidepad:
// revisioned document с ETag/304, semantic operations с серверным порядком,
// идемпотентный operation_id, 409 по ревизии и pairing exchange.
import { createHash, randomUUID } from 'node:crypto';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

class Rejected extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function cleanUrl(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

export class FakeNotesApi {
  constructor({ title = 'Synthetic', sections = [] } = {}) {
    this.title = title;
    this.sections = sections.map(([name, tasks]) => ({
      name,
      tasks: tasks.map((item) => ({
        text: item.replace(/^\[[ x]\] /, ''),
        done: item.startsWith('[x] '),
        url: null,
      })),
    }));
    this.pairings = new Map();
    this.credential = null;
    this.completed = new Map();
    this.log = [];
    this.offline = false;
    this.failNext = null;
    this.extensionOrigin = null;
  }

  revision() {
    return createHash('sha256').update(JSON.stringify({ title: this.title, sections: this.sections })).digest('hex');
  }

  document() {
    const tag = this.revision().slice(0, 8);
    return {
      title: this.title,
      sections: this.sections.map((section, s) => ({
        ref: `s_${tag}_${s}`,
        name: section.name,
        tasks: section.tasks.map((task, t) => ({ ref: `t_${tag}_${s}_${t}`, ...task })),
      })),
    };
  }

  markdownModel() {
    return this.sections.map((section) => [section.name, section.tasks.map((task) => `${task.done ? '[x]' : '[ ]'} ${task.text}`)]);
  }

  issuePairing() {
    const pairing = { pairing_id: randomUUID(), code: `syn-${randomUUID().slice(0, 13)}` };
    this.pairings.set(pairing.pairing_id, pairing.code);
    return pairing;
  }

  versioned(status = 200) {
    const revision = this.revision();
    return {
      status,
      headers: { ...JSON_HEADERS, ETag: `"${revision}"` },
      body: JSON.stringify({ document: this.document(), revision }),
    };
  }

  error(status, code, extra = {}) {
    return { status, headers: JSON_HEADERS, body: JSON.stringify({ error: { code, message: code }, ...extra }) };
  }

  handle({ method, url, headers = {}, body }) {
    const path = new URL(url).pathname;
    const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] || null;
    const entry = { method, path, authorized: authorization === `Bearer ${this.credential}`, body: body ? JSON.parse(body) : null };
    this.log.push(entry);
    if (this.offline) return { fail: true };

    if (method === 'GET' && path === '/') {
      return { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<!doctype html><title>Synthetic Notes Lab</title><p>synthetic</p>' };
    }
    if (method === 'POST' && path === '/api/auth/pairings/exchange') {
      const { pairing_id: pairingId, code, label } = entry.body || {};
      if (!label || this.pairings.get(pairingId) !== code) return this.error(401, 'pairing_invalid');
      this.pairings.delete(pairingId);
      const id = randomUUID();
      this.credential = `nlc_${id}.${randomUUID().replaceAll('-', '')}`;
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ credential_id: id, credential: this.credential, scopes: ['document:read', 'document:write'] }) };
    }
    if (!path.startsWith('/api/v1/')) return this.error(404, 'not_found');
    if (!entry.authorized) return this.error(401, 'auth_required');

    if (method === 'GET' && path === '/api/v1/document') {
      const ifNoneMatch = Object.entries(headers).find(([name]) => name.toLowerCase() === 'if-none-match')?.[1];
      if (ifNoneMatch === `"${this.revision()}"`) {
        return { status: 304, headers: { ETag: `"${this.revision()}"` }, body: '' };
      }
      return this.versioned();
    }
    if (method === 'POST' && path === '/api/v1/document/operations') {
      return this.mutate(entry.body);
    }
    return this.error(404, 'not_found');
  }

  mutate({ expected_revision: expected, operation_id: operationId, operation }) {
    const fingerprint = JSON.stringify({ expected, operation });
    const previous = this.completed.get(operationId);
    if (previous) {
      return previous.fingerprint === fingerprint ? previous.response : this.error(409, 'operation_id_reused');
    }
    if (this.failNext?.kind === 'status') {
      const { status, code } = this.failNext;
      this.failNext = null;
      return this.error(status, code);
    }
    if (expected !== this.revision()) return this.error(409, 'revision_conflict', { current_revision: this.revision() });
    try {
      this.apply(operation);
    } catch (error) {
      if (error instanceof Rejected) return this.error(error.status, error.code);
      throw error;
    }
    const response = this.versioned();
    this.completed.set(operationId, { fingerprint, response });
    if (this.failNext?.kind === 'lost-response') {
      this.failNext = null;
      return { fail: true };
    }
    return response;
  }

  sectionByRef(ref) {
    const index = this.document().sections.findIndex((section) => section.ref === ref);
    if (index < 0) throw new Rejected(404, 'section_not_found');
    return index;
  }

  taskByRef(ref) {
    const doc = this.document();
    for (let s = 0; s < doc.sections.length; s += 1) {
      const t = doc.sections[s].tasks.findIndex((task) => task.ref === ref);
      if (t >= 0) return [s, t];
    }
    throw new Rejected(404, 'task_not_found');
  }

  setDone(s, t, done) {
    const tasks = this.sections[s].tasks;
    const task = tasks[t];
    const was = task.done;
    task.done = done;
    if (!was && done) tasks.push(...tasks.splice(t, 1));
    else if (was && !done) tasks.unshift(...tasks.splice(t, 1));
  }

  apply(op) {
    switch (op.type) {
      case 'task.create': {
        const s = this.sectionByRef(op.section_ref);
        this.sections[s].tasks.unshift({ text: op.task.text, done: Boolean(op.task.done), url: cleanUrl(op.task.url) });
        return;
      }
      case 'task.update': {
        const [s, t] = this.taskByRef(op.task_ref);
        const task = this.sections[s].tasks[t];
        if ('text' in op.task) task.text = op.task.text;
        if ('url' in op.task) task.url = cleanUrl(op.task.url);
        if ('done' in op.task) this.setDone(s, t, op.task.done);
        return;
      }
      case 'task.toggle': {
        const [s, t] = this.taskByRef(op.task_ref);
        this.setDone(s, t, op.done);
        return;
      }
      case 'task.delete': {
        const [s, t] = this.taskByRef(op.task_ref);
        this.sections[s].tasks.splice(t, 1);
        return;
      }
      case 'task.move': {
        const [s, t] = this.taskByRef(op.task_ref);
        const target = this.sectionByRef(op.target_section_ref);
        const [task] = this.sections[s].tasks.splice(t, 1);
        const tasks = this.sections[target].tasks;
        const index = op.index ?? tasks.length;
        if (index > tasks.length) throw new Rejected(400, 'validation_error');
        tasks.splice(index, 0, task);
        return;
      }
      case 'section.create': {
        if (this.sections.some((section) => section.name === op.section.name)) throw new Rejected(400, 'validation_error');
        const index = op.index ?? this.sections.length;
        const tasks = op.task ? [{ text: op.task.text, done: false, url: cleanUrl(op.task.url) }] : [];
        this.sections.splice(index, 0, { name: op.section.name, tasks });
        return;
      }
      case 'section.update': {
        const s = this.sectionByRef(op.section_ref);
        if (this.sections.some((section, i) => i !== s && section.name === op.section.name)) throw new Rejected(400, 'validation_error');
        this.sections[s].name = op.section.name;
        return;
      }
      case 'section.delete': {
        const s = this.sectionByRef(op.section_ref);
        if (this.sections[s].tasks.length && op.confirm !== true) throw new Rejected(409, 'confirmation_required');
        this.sections.splice(s, 1);
        return;
      }
      case 'section.move': {
        const s = this.sectionByRef(op.section_ref);
        const [section] = this.sections.splice(s, 1);
        if (op.index > this.sections.length) throw new Rejected(400, 'validation_error');
        this.sections.splice(op.index, 0, section);
        return;
      }
      default:
        throw new Rejected(400, 'validation_error');
    }
  }

  mutations() {
    return this.log.filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/document/operations');
  }
}

// Подменяет https://notes.lab для одной CDP-сессии (панель, service worker
// или вкладка web) — запросы не уходят в сеть.
export async function interceptNotesLab(session, fake) {
  session.on('Fetch.requestPaused', (params) => {
    const response = fake.handle({
      method: params.request.method,
      url: params.request.url,
      headers: params.request.headers,
      body: params.request.postData,
    });
    if (response.fail) {
      session.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
      return;
    }
    const headers = { ...response.headers };
    if (fake.extensionOrigin) {
      headers['Access-Control-Allow-Origin'] = fake.extensionOrigin;
      headers.Vary = 'Origin';
    }
    session.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: response.status,
      responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })),
      body: Buffer.from(response.body || '').toString('base64'),
    }).catch(() => {});
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: 'https://notes.lab/*', requestStage: 'Request' }] });
}
