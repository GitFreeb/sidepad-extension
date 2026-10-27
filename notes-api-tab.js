// Мост между привычной моделью вкладки Sidepad (плоский tasks[] + sections[])
// и revisioned документом Notes API. Refs действуют только в выдавшей их
// ревизии, поэтому намерение пользователя фиксируется по имени секции, позиции
// и содержимому задачи, а ref заново разрешается перед каждой отправкой —
// тот же контракт, что buildBulkMovePlan/resolveBulkMoveStep в web Notes Lab.

export const SERVER_TAB_ID = 'tab_notes_api';
export const SERVER_TAB_TITLE = 'notes';

// popup.js показывает кнопку удаления только у задач с id > 10000.
const TASK_ID_BASE = 10001;

export class StaleIntentError extends Error {
  constructor() {
    super('The document changed before the action could be applied.');
    this.name = 'StaleIntentError';
  }
}

// Markdown store Notes Lab отклоняет в тексте задачи табуляцию, переводы
// строк, управляющие символы, двойные пробелы и ссылки (у ссылки своё поле).
// Вставленный текст приводится к этим правилам, иначе сервер вернёт 400 и
// правка молча откатится к прежнему тексту. Правила и эталон нормализации —
// notes-lab docs/contracts/markdown-store.md; web normalizeTaskInput обязан совпадать.
const URL_IN_TEXT = /https?:\/\/[^\s<>"{}|\\^`[\]]+/i;

function collapseWhitespace(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeTaskInput(rawText, rawUrl = null) {
  let text = collapseWhitespace(rawText);
  let url = cleanUrl(rawUrl);
  const match = text.match(URL_IN_TEXT);
  if (match) {
    const found = match[0].replace(/[),>.;:!?]+$/, '');
    url = url || found;
    text = collapseWhitespace(text.replace(match[0], ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/^[,.;:!?\s]+|[,;:\s]+$/g, ''));
    if (!text) {
      try {
        text = new URL(found).host;
      } catch {
        text = '';
      }
    }
  }
  return { text, url };
}

export function normalizeSectionName(raw) {
  return collapseWhitespace(String(raw ?? '').replace(/^[\s#]+/, ''));
}

function cleanUrl(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function comparableTask(task) {
  return { text: task.text, done: Boolean(task.done), url: cleanUrl(task.url) };
}

function sameTask(left, right) {
  return left.text === right.text
    && Boolean(left.done) === Boolean(right.done)
    && cleanUrl(left.url) === cleanUrl(right.url);
}

export function documentToTab(document) {
  const sections = [];
  const tasks = [];
  for (const section of document?.sections || []) {
    sections.push(section.name);
    for (const task of section.tasks || []) {
      tasks.push({
        id: TASK_ID_BASE + tasks.length,
        section: section.name,
        text: task.text,
        url: task.url || '',
        done: Boolean(task.done),
      });
    }
  }
  return { tasks, sections };
}

function locateTask(document, id) {
  let flat = TASK_ID_BASE;
  for (const section of document.sections) {
    for (let taskIndex = 0; taskIndex < section.tasks.length; taskIndex += 1) {
      if (flat === id) {
        return { sectionName: section.name, taskIndex, task: comparableTask(section.tasks[taskIndex]) };
      }
      flat += 1;
    }
  }
  throw new StaleIntentError();
}

function resolveTask(document, step) {
  const sectionIndex = document.sections.findIndex((section) => section.name === step.sectionName);
  const section = document.sections[sectionIndex];
  const task = section?.tasks[step.taskIndex];
  if (!task || !sameTask(task, step.task)) throw new StaleIntentError();
  return { section, sectionIndex, task, taskIndex: step.taskIndex };
}

function resolveSection(document, name) {
  const sectionIndex = document.sections.findIndex((section) => section.name === name);
  if (sectionIndex < 0) throw new StaleIntentError();
  return { section: document.sections[sectionIndex], sectionIndex };
}

function requireSection(document, name) {
  resolveSection(document, name);
  return name;
}

function taskPayload(rawText, rawUrl) {
  const { text, url } = normalizeTaskInput(rawText, rawUrl);
  const payload = { text };
  if (url) payload.url = url;
  return payload;
}

export function captureIntent(document, intent) {
  switch (intent?.kind) {
    case 'task.create':
      return { kind: intent.kind, sectionName: normalizeSectionName(intent.sectionName), text: intent.text, url: intent.url || '' };
    case 'section.create':
      return { kind: intent.kind, name: normalizeSectionName(intent.name) };
    case 'task.toggle':
    case 'task.delete':
      return { kind: intent.kind, target: locateTask(document, intent.id) };
    case 'task.update':
      return { kind: intent.kind, target: locateTask(document, intent.id), text: intent.text };
    case 'task.move':
      return {
        kind: intent.kind,
        target: locateTask(document, intent.id),
        anchor: intent.anchorId === undefined ? null : locateTask(document, intent.anchorId),
        sectionName: intent.anchorId === undefined ? requireSection(document, intent.sectionName) : null,
        position: intent.position,
      };
    case 'section.update':
      return { kind: intent.kind, sectionName: requireSection(document, intent.sectionName), name: normalizeSectionName(intent.name) };
    case 'section.delete':
      return { kind: intent.kind, sectionName: requireSection(document, intent.sectionName) };
    case 'section.move':
      return {
        kind: intent.kind,
        sectionName: requireSection(document, intent.sectionName),
        anchorName: requireSection(document, intent.anchorName),
        position: intent.position,
      };
    default:
      throw new TypeError('Unknown Sidepad intent.');
  }
}

function planTaskMove(document, intent) {
  const source = resolveTask(document, intent.target);
  const operation = { type: 'task.move', task_ref: source.task.ref };
  if (intent.anchor) {
    const anchor = resolveTask(document, intent.anchor);
    const remaining = anchor.section.tasks.filter((task) => task.ref !== source.task.ref);
    const anchorIndex = remaining.findIndex((task) => task.ref === anchor.task.ref);
    operation.target_section_ref = anchor.section.ref;
    operation.index = intent.position === 'after' ? anchorIndex + 1 : anchorIndex;
    return operation;
  }
  const target = resolveSection(document, intent.sectionName);
  operation.target_section_ref = target.section.ref;
  if (intent.position === 'start') operation.index = 0;
  return operation;
}

export function planOperation(document, intent) {
  switch (intent.kind) {
    case 'task.create': {
      if (!normalizeTaskInput(intent.text, intent.url).text || !intent.sectionName) return null;
      const existing = document.sections.find((section) => section.name === intent.sectionName);
      if (existing) {
        return { type: 'task.create', section_ref: existing.ref, task: taskPayload(intent.text, intent.url) };
      }
      return { type: 'section.create', section: { name: intent.sectionName }, task: taskPayload(intent.text, intent.url), index: 0 };
    }
    case 'section.create':
      if (!intent.name) return null;
      if (document.sections.some((section) => section.name === intent.name)) return null;
      return { type: 'section.create', section: { name: intent.name }, index: 0 };
    case 'task.toggle': {
      const { task } = resolveTask(document, intent.target);
      return { type: 'task.toggle', task_ref: task.ref, done: !task.done };
    }
    case 'task.update': {
      const { task } = resolveTask(document, intent.target);
      if (!normalizeTaskInput(intent.text, null).text) return null;
      return { type: 'task.update', task_ref: task.ref, task: taskPayload(intent.text, null) };
    }
    case 'task.delete': {
      const { task } = resolveTask(document, intent.target);
      return { type: 'task.delete', task_ref: task.ref };
    }
    case 'task.move':
      return planTaskMove(document, intent);
    case 'section.update': {
      const { section } = resolveSection(document, intent.sectionName);
      return { type: 'section.update', section_ref: section.ref, section: { name: intent.name } };
    }
    case 'section.delete': {
      const { section } = resolveSection(document, intent.sectionName);
      return { type: 'section.delete', section_ref: section.ref, confirm: true };
    }
    case 'section.move': {
      const { section } = resolveSection(document, intent.sectionName);
      resolveSection(document, intent.anchorName);
      const remaining = document.sections.filter((item) => item.ref !== section.ref);
      const anchorIndex = remaining.findIndex((item) => item.name === intent.anchorName);
      return { type: 'section.move', section_ref: section.ref, index: intent.position === 'after' ? anchorIndex + 1 : anchorIndex };
    }
    default:
      throw new TypeError('Unknown Sidepad intent.');
  }
}
