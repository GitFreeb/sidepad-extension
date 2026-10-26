// Характеризация привычного Sidepad UI в настоящем браузере. Эти сценарии
// фиксируют поведение файловых вкладок до и после объединения с Notes API.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, browserExecutable, recordRequests } from './cdp.mjs';
import { legacyTab, openPopup, reload, reloadWithStorage } from './popup-helpers.mjs';

const executable = browserExecutable();
const skip = executable ? false : 'Chromium-based browser is not available';

let browser;
let page;
let pageRequests;
let workerRequests;

function seed(extra = {}) {
  return {
    tabs: [
      legacyTab('tab_work', 'work', [
        ['Alpha', ['one', 'two', '[x] three']],
        ['Beta', ['four']],
      ]),
      legacyTab('tab_dop', 'dop', [['Old', ['legacy item']]]),
    ],
    activeTabId: 'tab_work',
    ...extra,
  };
}

const model = () => page.evaluate('__t.model()');

before(async () => {
  if (skip) return;
  browser = await Browser.launch({ executable });
  const worker = await browser.serviceWorker();
  workerRequests = recordRequests(worker);
  page = await openPopup(browser, seed());
  pageRequests = recordRequests(page);
});

after(async () => {
  if (browser) await browser.close();
});

test('renders sections, tasks and counter from the active file tab', { skip }, async () => {
  await reloadWithStorage(page, seed());
  assert.deepEqual(await model(), [
    { name: 'Alpha', collapsed: false, tasks: ['[ ] one', '[ ] two', '[x] three'] },
    { name: 'Beta', collapsed: false, tasks: ['[ ] four'] },
  ]);
  assert.equal(await page.evaluate(`document.getElementById('counter').textContent`), '1 / 4');
  assert.equal(await page.evaluate(`document.getElementById('bcFile').textContent`), 'work.md');
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['*work.md', 'dop.md']);
  assert.equal(await page.evaluate(`document.getElementById('apiModeToggle').checked`), false);
});

test('adds tasks to the top of the selected section, a new section, or an auto-named section', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    [...document.querySelectorAll('#sectionSelectList .csel-item')].find((li) => li.dataset.value === 'Beta')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.type('#linkInput', 'https://example.test/a', null);
    __t.type('#taskInput', 'fresh');
  })()`);
  let current = await model();
  assert.deepEqual(current[1].tasks, ['[ ] fresh', '[ ] four']);
  assert.equal(await page.evaluate(`__t.task('fresh').querySelector('.task-link').textContent`), 'https://example.test/a');

  await page.evaluate(`__t.type('#taskInput', 'orphan')`);
  current = await model();
  assert.equal(current[0].name, 'Новая секция 1');
  assert.deepEqual(current[0].tasks, ['[ ] orphan']);

  await page.evaluate(`__t.type('#sectionInput', 'Empty')`);
  current = await model();
  assert.equal(current[0].name, 'Empty');
  assert.deepEqual(current[0].tasks, []);
  assert.equal(await page.evaluate(`document.querySelector('.section-empty').textContent`), 'нет задач');

  await page.evaluate(`(() => { __t.type('#sectionInput', 'Named', null); __t.type('#taskInput', 'inside'); })()`);
  current = await model();
  assert.deepEqual(current[0], { name: 'Named', collapsed: false, tasks: ['[ ] inside'] });

  const stored = await page.evaluate(`__t.storage(['tabs'])`);
  const work = stored.tabs.find((tab) => tab.id === 'tab_work');
  assert.deepEqual(work.sections.slice(0, 3), ['Named', 'Empty', 'Новая секция 1']);
});

test('toggle moves a finished task to the end and a reopened task to the top', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.task('one').querySelector('.task-checkbox').click()`);
  assert.deepEqual((await model())[0].tasks, ['[ ] two', '[x] three', '[x] one']);
  await page.evaluate(`__t.task('three').querySelector('.task-checkbox').click()`);
  assert.deepEqual((await model())[0].tasks, ['[ ] three', '[ ] two', '[x] one']);
  assert.equal(await page.evaluate(`document.getElementById('counter').textContent`), '1 / 4');
});

test('a section whose tasks are all done collapses automatically', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.task('four').querySelector('.task-checkbox').click()`);
  assert.deepEqual((await model())[1], { name: 'Beta', collapsed: true, tasks: [] });
  await page.evaluate(`__t.section('Beta').click()`);
  assert.deepEqual((await model())[1], { name: 'Beta', collapsed: false, tasks: ['[x] four'] });
});

test('edits task text inline and deletes a task', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.task('two').querySelector('.task-text').click()`);
  await page.evaluate(`__t.type('.task-edit-input', 'two edited')`);
  assert.deepEqual((await model())[0].tasks, ['[ ] one', '[ ] two edited', '[x] three']);
  await page.evaluate(`__t.task('one').querySelector('.btn-delete').click()`);
  assert.deepEqual((await model())[0].tasks, ['[ ] two edited', '[x] three']);
});

test('renames and deletes sections', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.section('Beta').querySelector('.btn-rename-section').click()`);
  await page.evaluate(`__t.type('.section-rename-input', 'Gamma')`);
  assert.deepEqual((await model()).map((s) => s.name), ['Alpha', 'Gamma']);
  await page.evaluate(`__t.section('Alpha').querySelector('.btn-delete-section').click()`);
  assert.deepEqual(await model(), [{ name: 'Gamma', collapsed: false, tasks: ['[ ] four'] }]);
});

test('move menu sends a task to the top of another section', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.task('two').querySelector('.btn-move').click()`);
  await page.evaluate(`document.querySelector('.move-section-menu [data-section="Beta"]').click()`);
  const current = await model();
  assert.deepEqual(current[0].tasks, ['[ ] one', '[x] three']);
  assert.deepEqual(current[1].tasks, ['[ ] two', '[ ] four']);
});

test('drag and drop reorders tasks, moves them between sections and reorders sections', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.drag(__t.task('one'), __t.task('two'), 'after')`);
  assert.deepEqual((await model())[0].tasks, ['[ ] two', '[ ] one', '[x] three']);

  await page.evaluate(`__t.drag(__t.task('two'), __t.task('four'), 'after')`);
  let current = await model();
  assert.deepEqual(current[0].tasks, ['[ ] one', '[x] three']);
  assert.deepEqual(current[1].tasks, ['[ ] four', '[ ] two']);

  await page.evaluate(`__t.drag(__t.task('four'), __t.section('Alpha'))`);
  current = await model();
  assert.deepEqual(current[0].tasks, ['[ ] one', '[x] three', '[ ] four']);

  await page.evaluate(`__t.drag(__t.section('Beta'), __t.section('Alpha'), 'before')`);
  assert.deepEqual((await model()).map((s) => s.name), ['Beta', 'Alpha']);
});

test('collapse all toggles every section and restores auto-collapse state', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.click('#collapseAllBtn')`);
  assert.deepEqual((await model()).map((s) => s.collapsed), [true, true]);
  assert.equal(await page.evaluate(`document.getElementById('collapseAllBtn').textContent`), '▾ развернуть');
  await page.evaluate(`__t.click('#collapseAllBtn')`);
  assert.deepEqual((await model()).map((s) => s.collapsed), [false, false]);
});

test('tabs switch, rename, reorder by drag and persist the active tab', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.tab('dop.md').click()`);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['work.md', '*dop.md']);
  assert.deepEqual((await model()).map((s) => s.name), ['Old']);

  await page.evaluate(`__t.dblclick(__t.tab('dop.md'))`);
  await page.evaluate(`__t.type('.tab-rename-input', 'archive')`);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['work.md', '*archive.md']);

  await page.evaluate(`__t.drag(__t.tab('archive.md'), __t.tab('work.md'), 'before', 'x')`);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['*archive.md', 'work.md']);

  await reload(page);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['*archive.md', 'work.md']);
});

test('closing a non-default tab without auto-save asks before discarding', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`(() => { window.__confirmAnswer = false; __t.tab('work.md').querySelector('.tab-close').click(); })()`);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['*work.md', 'dop.md']);
  assert.equal(await page.evaluate('__dialogs.at(-1).message'), 'Список будет закрыт без сохранения. Продолжить?');
  await page.evaluate(`(() => { window.__confirmAnswer = true; __t.tab('work.md').querySelector('.tab-close').click(); })()`);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['*dop.md']);
});

test('✕ clear closes the active tab after confirmation and falls back to default', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.click('#clearDoneBtn')`);
  assert.equal(await page.evaluate('__dialogs.at(-1).message'), 'Список будет закрыт без сохранения. Продолжить?');
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['dop.md', '*default.md']);
  assert.equal(await page.evaluate(`document.querySelector('.empty-msg') !== null`), true);
});

test('import creates a new tab from a Markdown file and export produces the same Markdown', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`(() => {
    const input = document.getElementById('importFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File(['# plan\\n\\n## Inbox\\n\\n- [ ] alpha  https://example.test/x\\n- [x] beta\\n'], 'plan.md', { type: 'text/markdown' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor(`__t.tabs().includes('*plan.md')`);
  assert.deepEqual(await model(), [{ name: 'Inbox', collapsed: false, tasks: ['[ ] alpha', '[x] beta'] }]);

  const exported = await page.evaluate(`new Promise((resolve) => {
    window.showSaveFilePicker = undefined;
    chrome.downloads.download = async (options, callback) => {
      const text = await fetch(options.url).then((r) => r.text());
      callback?.();
      resolve({ text, filename: options.filename });
    };
    __t.click('#exportBtn');
  })`);
  assert.equal(exported.filename, 'plan.md');
  assert.equal(exported.text, '# plan.md\n\n## Inbox\n\n- [ ] alpha  https://example.test/x\n- [x] beta');
});

test('language switch re-renders the static UI in English', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.click('#langBtn')`);
  assert.equal(await page.evaluate(`document.getElementById('addBtn').textContent`), '+ add');
  assert.equal(await page.evaluate(`document.getElementById('clearDoneBtn').textContent`), '✕ clear');
});

test('legacy mode never contacts Notes API from the panel or the service worker', { skip }, async () => {
  const touchesNotes = (urls) => urls.filter((url) => url.startsWith('https://notes.lab'));
  assert.ok(pageRequests.some((url) => url.endsWith('/popup.js')), 'request journal must observe panel loads');
  assert.deepEqual(touchesNotes(pageRequests), []);
  assert.deepEqual(touchesNotes(workerRequests), []);
  const stored = await page.evaluate(`__t.storage(null)`);
  assert.equal(Object.keys(stored).some((key) => key.startsWith('notesApi')), false);
});

test('file tabs keep a section named «Неразобранные» in place and fully editable', { skip }, async () => {
  await reloadWithStorage(page, {
    tabs: [legacyTab('tab_inbox', 'inbox', [['First', ['a']], ['Неразобранные', ['b']]])],
    activeTabId: 'tab_inbox',
  });
  assert.deepEqual((await model()).map((s) => s.name), ['First', 'Неразобранные']);
  assert.equal(await page.evaluate(`__t.section('Неразобранные').classList.contains('inbox')`), false);
  assert.equal(await page.evaluate(`document.getElementById('taskInput').maxLength`), 240);
  await page.evaluate(`__t.section('Неразобранные').querySelector('.btn-rename-section').click()`);
  await page.evaluate(`__t.type('.section-rename-input', 'Renamed')`);
  assert.deepEqual((await model()).map((s) => s.name), ['First', 'Renamed']);
});
