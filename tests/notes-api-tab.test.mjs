import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StaleIntentError,
  captureIntent,
  documentToTab,
  planOperation,
} from '../notes-api-tab.js';

function doc(revisionTag, sections) {
  return {
    title: 'Synthetic',
    sections: sections.map(([name, tasks], s) => ({
      ref: `s_${revisionTag}_${s}`,
      name,
      tasks: tasks.map((item, t) => ({
        ref: `t_${revisionTag}_${s}_${t}`,
        text: item.replace(/^\[[ x]\] /, ''),
        done: item.startsWith('[x] '),
        url: null,
      })),
    })),
  };
}

const base = doc('a', [
  ['Inbox', ['one', 'two', '[x] three']],
  ['Work', ['four']],
  ['Empty', []],
]);

function idOf(document, text) {
  return documentToTab(document).tasks.find((task) => task.text === text).id;
}

test('document maps to legacy tab model with stable order, empty sections and deletable ids', () => {
  const tab = documentToTab(base);
  assert.deepEqual(tab.sections, ['Inbox', 'Work', 'Empty']);
  assert.deepEqual(tab.tasks.map((task) => [task.section, task.text, task.done, task.url]), [
    ['Inbox', 'one', false, ''],
    ['Inbox', 'two', false, ''],
    ['Inbox', 'three', true, ''],
    ['Work', 'four', false, ''],
  ]);
  assert.ok(tab.tasks.every((task) => task.id > 10000));
  assert.equal(new Set(tab.tasks.map((task) => task.id)).size, 4);
  assert.equal(Object.hasOwn(tab.tasks[0], 'ref'), false);
});

test('task intents become single semantic operations with fresh refs', () => {
  const toggle = captureIntent(base, { kind: 'task.toggle', id: idOf(base, 'two') });
  assert.deepEqual(planOperation(base, toggle), { type: 'task.toggle', task_ref: 't_a_0_1', done: true });

  const reopen = captureIntent(base, { kind: 'task.toggle', id: idOf(base, 'three') });
  assert.deepEqual(planOperation(base, reopen), { type: 'task.toggle', task_ref: 't_a_0_2', done: false });

  const edit = captureIntent(base, { kind: 'task.update', id: idOf(base, 'four'), text: 'four!' });
  assert.deepEqual(planOperation(base, edit), { type: 'task.update', task_ref: 't_a_1_0', task: { text: 'four!' } });

  const remove = captureIntent(base, { kind: 'task.delete', id: idOf(base, 'one') });
  assert.deepEqual(planOperation(base, remove), { type: 'task.delete', task_ref: 't_a_0_0' });
});

test('create uses the existing section or creates a new one at the top', () => {
  const existing = captureIntent(base, { kind: 'task.create', sectionName: 'Work', text: 'new', url: 'https://example.test' });
  assert.deepEqual(planOperation(base, existing), {
    type: 'task.create', section_ref: 's_a_1', task: { text: 'new', url: 'https://example.test' },
  });

  const fresh = captureIntent(base, { kind: 'task.create', sectionName: 'Later', text: 'new', url: '' });
  assert.deepEqual(planOperation(base, fresh), {
    type: 'section.create', section: { name: 'Later' }, task: { text: 'new' }, index: 0,
  });

  const emptySection = captureIntent(base, { kind: 'section.create', name: 'Plans' });
  assert.deepEqual(planOperation(base, emptySection), { type: 'section.create', section: { name: 'Plans' }, index: 0 });
  assert.equal(planOperation(base, captureIntent(base, { kind: 'section.create', name: 'Work' })), null);
});

test('drag positions translate to task.move indexes counted after removal', () => {
  const after = captureIntent(base, { kind: 'task.move', id: idOf(base, 'one'), anchorId: idOf(base, 'two'), position: 'after' });
  assert.deepEqual(planOperation(base, after), { type: 'task.move', task_ref: 't_a_0_0', target_section_ref: 's_a_0', index: 1 });

  const before = captureIntent(base, { kind: 'task.move', id: idOf(base, 'three'), anchorId: idOf(base, 'one'), position: 'before' });
  assert.deepEqual(planOperation(base, before), { type: 'task.move', task_ref: 't_a_0_2', target_section_ref: 's_a_0', index: 0 });

  const across = captureIntent(base, { kind: 'task.move', id: idOf(base, 'two'), anchorId: idOf(base, 'four'), position: 'after' });
  assert.deepEqual(planOperation(base, across), { type: 'task.move', task_ref: 't_a_0_1', target_section_ref: 's_a_1', index: 1 });

  const start = captureIntent(base, { kind: 'task.move', id: idOf(base, 'two'), sectionName: 'Work', position: 'start' });
  assert.deepEqual(planOperation(base, start), { type: 'task.move', task_ref: 't_a_0_1', target_section_ref: 's_a_1', index: 0 });

  const end = captureIntent(base, { kind: 'task.move', id: idOf(base, 'four'), sectionName: 'Empty', position: 'end' });
  assert.deepEqual(planOperation(base, end), { type: 'task.move', task_ref: 't_a_1_0', target_section_ref: 's_a_2' });
});

test('section intents rename, delete with confirmation and move by index', () => {
  assert.deepEqual(planOperation(base, captureIntent(base, { kind: 'section.update', sectionName: 'Work', name: 'Job' })), {
    type: 'section.update', section_ref: 's_a_1', section: { name: 'Job' },
  });
  assert.deepEqual(planOperation(base, captureIntent(base, { kind: 'section.delete', sectionName: 'Inbox' })), {
    type: 'section.delete', section_ref: 's_a_0', confirm: true,
  });
  assert.deepEqual(planOperation(base, captureIntent(base, { kind: 'section.move', sectionName: 'Empty', anchorName: 'Inbox', position: 'before' })), {
    type: 'section.move', section_ref: 's_a_2', index: 0,
  });
  assert.deepEqual(planOperation(base, captureIntent(base, { kind: 'section.move', sectionName: 'Inbox', anchorName: 'Work', position: 'after' })), {
    type: 'section.move', section_ref: 's_a_0', index: 1,
  });
});

test('queued intents resolve against the newer revision like resolveBulkMoveStep', () => {
  const toggleTwo = captureIntent(base, { kind: 'task.toggle', id: idOf(base, 'two') });
  const deleteFour = captureIntent(base, { kind: 'task.delete', id: idOf(base, 'four') });

  // Первая операция (toggle «one») уже применена сервером: позиции и refs сменились.
  const afterFirst = doc('b', [
    ['Inbox', ['two', '[x] three', '[x] one']],
    ['Work', ['four']],
    ['Empty', []],
  ]);
  assert.throws(() => planOperation(afterFirst, toggleTwo), StaleIntentError);
  assert.deepEqual(planOperation(afterFirst, deleteFour), { type: 'task.delete', task_ref: 't_b_1_0' });
});

test('intent is stale when its section disappeared or the task content changed', () => {
  const editTwo = captureIntent(base, { kind: 'task.update', id: idOf(base, 'two'), text: 'x' });
  const renamed = doc('c', [['Inbox', ['one', 'two changed', '[x] three']], ['Work', ['four']]]);
  assert.throws(() => planOperation(renamed, editTwo), StaleIntentError);

  const moveToEmpty = captureIntent(base, { kind: 'task.move', id: idOf(base, 'one'), sectionName: 'Empty', position: 'end' });
  const withoutEmpty = doc('d', [['Inbox', ['one', 'two', '[x] three']], ['Work', ['four']]]);
  assert.throws(() => planOperation(withoutEmpty, moveToEmpty), StaleIntentError);

  const renameMissing = captureIntent(base, { kind: 'section.update', sectionName: 'Empty', name: 'Full' });
  assert.throws(() => planOperation(withoutEmpty, renameMissing), StaleIntentError);
});

test('captureIntent rejects ids and sections that are not in the rendered snapshot', () => {
  assert.throws(() => captureIntent(base, { kind: 'task.toggle', id: 1 }), StaleIntentError);
  assert.throws(() => captureIntent(base, { kind: 'section.delete', sectionName: 'Nope' }), StaleIntentError);
  assert.throws(() => captureIntent(base, { kind: 'unknown' }), TypeError);
});

test('pasted text is normalized to what the Markdown store accepts', async () => {
  const { normalizeTaskInput, normalizeSectionName } = await import('../notes-api-tab.js');
  assert.deepEqual(normalizeTaskInput('  first\tsecond  third  end  '), { text: 'first second third end', url: null });
  assert.deepEqual(normalizeTaskInput('line one\nline two\r\nthree'), { text: 'line one line two three', url: null });
  assert.deepEqual(normalizeTaskInput('read this https://example.test/a, later'), { text: 'read this later', url: 'https://example.test/a' });
  assert.deepEqual(normalizeTaskInput('https://example.test/only'), { text: 'example.test', url: 'https://example.test/only' });
  assert.deepEqual(normalizeTaskInput('text', 'https://example.test/x'), { text: 'text', url: 'https://example.test/x' });
  assert.deepEqual(normalizeTaskInput(' \t\n '), { text: '', url: null });
  assert.equal(normalizeSectionName('  ## Plans\tnext  '), 'Plans next');
});

test('create and update send normalized text and move a pasted URL into the url field', () => {
  const edit = captureIntent(base, { kind: 'task.update', id: idOf(base, 'two'), text: 'two  edited\twith https://example.test/p' });
  assert.deepEqual(planOperation(base, edit), { type: 'task.update', task_ref: 't_a_0_1', task: { text: 'two edited with', url: 'https://example.test/p' } });
  const plain = captureIntent(base, { kind: 'task.update', id: idOf(base, 'two'), text: 'two\nnew' });
  assert.deepEqual(planOperation(base, plain), { type: 'task.update', task_ref: 't_a_0_1', task: { text: 'two new' } });
  const create = captureIntent(base, { kind: 'task.create', sectionName: 'Work', text: 'a  b https://example.test/c', url: '' });
  assert.deepEqual(planOperation(base, create), { type: 'task.create', section_ref: 's_a_1', task: { text: 'a b', url: 'https://example.test/c' } });
  const section = captureIntent(base, { kind: 'section.update', sectionName: 'Work', name: '#  Job\tnow' });
  assert.deepEqual(planOperation(base, section), { type: 'section.update', section_ref: 's_a_1', section: { name: 'Job now' } });
});
