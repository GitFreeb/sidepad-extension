// Единый интерфейс поверх Notes API в настоящем браузере: вкладка notes.md
// выглядит и ведёт себя как файловая, но каждое действие уходит semantic
// operation в синтетический Notes API. Данные полностью синтетические.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Browser, browserExecutable, extensionCopyWithNotesAccess } from './cdp.mjs';
import { FakeNotesApi, interceptNotesLab } from './fake-notes-api.mjs';
import { PAGE_HELPERS, legacyTab, reload, reloadWithStorage } from './popup-helpers.mjs';

const executable = browserExecutable();
const skip = executable ? false : 'Chromium-based browser is not available';

let browser;
let extensionDir;
let fake;
let page;
let worker;
const consoleLines = [];

const model = () => page.evaluate('__t.model()');
const op = (index = -1) => fake.mutations().at(index)?.body?.operation;
const settle = () => page.waitFor(`document.getElementById('syncState').dataset.kind === 'current'`, { timeout: 8000 })
  .catch(async (error) => {
    const state = await page.evaluate(`JSON.stringify({ kind: document.getElementById('syncState').dataset.kind, notice: document.getElementById('serverNoticeText').textContent, tabs: __t.tabs() })`);
    throw new Error(`${error.message} ${state}`);
  });

function captureConsole(session) {
  session.on('Runtime.consoleAPICalled', ({ args }) => {
    consoleLines.push(args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  });
  session.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    consoleLines.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });
}

// Страница с origin https://notes.lab, которая говорит с расширением ровно
// так же, как web Notes Lab S12A (sendSidepadMessage в app.js).
async function openNotesWeb() {
  const web = await browser.open('https://notes.lab/', { setup: (session) => interceptNotesLab(session, fake) });
  captureConsole(web);
  return web;
}

function sendFromWeb(web, message) {
  return web.evaluate(`new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify(browser.extensionId)}, ${JSON.stringify(message)}, (response) => resolve(chrome.runtime.lastError ? { lastError: chrome.runtime.lastError.message } : response)))`);
}

function seed() {
  return {
    tabs: [
      legacyTab('tab_work', 'work', [['Alpha', ['one']]]),
      legacyTab('tab_dop', 'dop', [['Old', ['legacy item', '[x] legacy done']]]),
    ],
    activeTabId: 'tab_work',
  };
}

before(async () => {
  if (skip) return;
  extensionDir = extensionCopyWithNotesAccess();
  fake = new FakeNotesApi({
    sections: [
      ['Inbox', ['first', 'second', '[x] closed']],
      ['Work', ['report']],
    ],
  });
  browser = await Browser.launch({ executable, extension: extensionDir });
  fake.extensionOrigin = `chrome-extension://${browser.extensionId}`;
  worker = await browser.serviceWorker();
  captureConsole(worker);
  await interceptNotesLab(worker, fake);
  page = await browser.open(browser.extensionUrl('popup.html'), {
    beforeLoad: PAGE_HELPERS,
    setup: (session) => interceptNotesLab(session, fake),
  });
  captureConsole(page);
  await reloadWithStorage(page, seed());
});

after(async () => {
  if (browser) await browser.close();
  if (extensionDir) rmSync(extensionDir, { recursive: true, force: true });
});

test('enabling Notes API opens the connect page, keeps the legacy UI and offers dop.md as legacy', { skip }, async () => {
  await page.evaluate(`__t.click('#apiModeToggle')`);
  await page.waitFor(`__t.tabs().includes('*notes.md')`);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['work.md', 'dop.md', '*notes.md']);
  await page.waitFor(`document.getElementById('syncState').dataset.kind === 'pending'`);
  const opened = browser.createdTargets.map((info) => info.url);
  assert.ok(opened.includes(`https://notes.lab/#sidepad-connect=${browser.extensionId}`), opened.join('\n'));

  assert.equal(await page.evaluate(`document.getElementById('apiSettings').hidden`), false);
  assert.equal(await page.evaluate(`document.getElementById('apiLegacySelect').selectedOptions[0].textContent`), 'dop.md');
  assert.equal(await page.evaluate(`document.getElementById('apiRecovery').open`), false);
  for (const id of ['addBtn', 'taskInput', 'sectionInput', 'importBtn', 'exportBtn', 'collapseAllBtn', 'clearDoneBtn', 'taskList']) {
    assert.equal(await page.evaluate(`document.getElementById('${id}').offsetParent !== null`), true, id);
  }
  assert.equal(fake.log.filter((entry) => entry.path.startsWith('/api/')).length, 0, 'nothing is requested before pairing');
});

test('web probe and pair connect Sidepad through the service worker only', { skip }, async () => {
  const web = await openNotesWeb();
  const probe = await sendFromWeb(web, { type: 'notes-lab.connect.probe', notes_origin: 'https://notes.lab' });
  assert.equal(probe.ok, true);
  assert.equal(probe.extension_id, browser.extensionId);
  assert.equal(probe.name, 'Sidepad');
  assert.match(probe.browser, /^(Chromium|Chrome|Brave|Edge)/);
  assert.ok(probe.pending_expires_at > Date.now() / 1000 && probe.pending_expires_at <= Date.now() / 1000 + 600);

  assert.deepEqual(await sendFromWeb(web, { type: 'notes-lab.connect.probe', notes_origin: 'https://notes.lab', extra: true }), { ok: false });

  const pairing = fake.issuePairing();
  const result = await sendFromWeb(web, {
    type: 'notes-lab.connect.pair',
    notes_origin: 'https://notes.lab',
    pairing_id: pairing.pairing_id,
    code: pairing.code,
    label: `Sidepad · ${probe.browser}`,
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(fake.credential);
  assert.deepEqual(await sendFromWeb(web, { type: 'notes-lab.connect.probe', notes_origin: 'https://notes.lab' }), { ok: false });
  await browser.closeTarget(web);
  await browser.send('Target.activateTarget', { targetId: page.targetId });
  await page.waitFor(`document.visibilityState === 'visible'`);

  await settle();
  assert.deepEqual(await model(), [
    { name: 'Inbox', collapsed: false, tasks: ['[ ] first', '[ ] second', '[x] closed'] },
    { name: 'Work', collapsed: false, tasks: ['[ ] report'] },
  ]);
  assert.equal(await page.evaluate(`document.querySelector('.bc-path').textContent`), 'notes.lab/');
  assert.equal(await page.evaluate(`document.getElementById('syncState').textContent`), '✓');
});

test('legacy choice is explicit: saving dop.md locks it read-only while other file tabs stay editable', { skip }, async () => {
  await page.evaluate(`__t.click('#apiLegacySaveBtn')`);
  assert.deepEqual((await page.evaluate(`__t.storage(['notesApiLegacyTabV1'])`)).notesApiLegacyTabV1, { tabId: 'tab_dop' });
  assert.equal(await page.evaluate(`document.getElementById('apiSettings').hidden`), true);

  await page.evaluate(`__t.tab('dop.md').click()`);
  assert.equal(await page.evaluate(`document.getElementById('serverNotice').hidden`), false);
  assert.match(await page.evaluate(`document.getElementById('serverNoticeText').textContent`), /legacy · только чтение/);
  assert.equal(await page.evaluate(`__t.task('legacy item').querySelector('.task-checkbox').disabled`), true);
  assert.equal(await page.evaluate(`__t.task('legacy item').querySelector('.btn-delete')`), null);
  await page.evaluate(`__t.task('legacy item').querySelector('.task-checkbox').click()`);
  await page.evaluate(`__t.type('#taskInput', 'must not appear')`);
  assert.deepEqual(await model(), [{ name: 'Old', collapsed: false, tasks: ['[ ] legacy item', '[x] legacy done'] }]);
  const stored = await page.evaluate(`__t.storage(['tabs'])`);
  assert.deepEqual(stored.tabs.find((tab) => tab.id === 'tab_dop').tasks.map((task) => task.text), ['legacy item', 'legacy done']);

  await page.evaluate(`__t.tab('work.md').click()`);
  await page.evaluate(`__t.type('#taskInput', 'file task')`);
  assert.deepEqual((await model())[0].tasks.slice(0, 1), ['[ ] file task']);

  await page.evaluate(`__t.tab('dop.md').click()`);
  await page.evaluate(`[...document.querySelectorAll('.server-notice-btn')].find((b) => b.textContent === 'перейти в notes.md').click()`);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['work.md', 'dop.md', '*notes.md']);
});

test('adding tasks and sections sends semantic operations and renders the server order', { skip }, async () => {
  await settle();
  const before = fake.mutations().length;
  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    [...document.querySelectorAll('#sectionSelectList .csel-item')].find((li) => li.dataset.value === 'Work')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.type('#linkInput', 'https://example.test/r', null);
    __t.type('#taskInput', 'draft review');
  })()`);
  await page.waitFor(`__t.task('draft review') !== undefined`);
  assert.deepEqual(op(), { type: 'task.create', section_ref: op().section_ref, task: { text: 'draft review', url: 'https://example.test/r' } });
  assert.deepEqual((await model())[1].tasks, ['[ ] draft review', '[ ] report']);
  assert.equal(await page.evaluate(`__t.task('draft review').querySelector('.task-link').textContent`), 'https://example.test/r');

  await page.evaluate(`__t.type('#taskInput', 'loose idea')`);
  await page.waitFor(`__t.section('Новая секция 1') !== undefined`);
  assert.equal(op().type, 'section.create');
  assert.deepEqual((await model())[0], { name: 'Новая секция 1', collapsed: false, tasks: ['[ ] loose idea'] });

  await page.evaluate(`__t.type('#sectionInput', 'Someday')`);
  await page.waitFor(`__t.section('Someday') !== undefined`);
  assert.deepEqual(op(), { type: 'section.create', section: { name: 'Someday' }, index: 0 });
  assert.deepEqual(fake.markdownModel().map(([name]) => name), ['Someday', 'Новая секция 1', 'Inbox', 'Work']);
  assert.equal(fake.mutations().length, before + 3);
  assert.ok(fake.mutations().every((entry) => entry.authorized && !('document' in entry.body) && !('markdown' in entry.body)));
});

test('toggle, inline edit and delete map to task.toggle, task.update and task.delete', { skip }, async () => {
  await settle();
  await page.evaluate(`__t.task('first').querySelector('.task-checkbox').click()`);
  await page.waitFor(`__t.model().find((s) => s.name === 'Inbox').tasks.at(-1) === '[x] first'`);
  assert.equal(op().type, 'task.toggle');
  assert.equal(op().done, true);
  assert.deepEqual((await model()).find((s) => s.name === 'Inbox').tasks, ['[ ] second', '[x] closed', '[x] first']);

  await page.evaluate(`__t.task('closed').querySelector('.task-checkbox').click()`);
  await page.waitFor(`__t.model().find((s) => s.name === 'Inbox').tasks[0] === '[ ] closed'`);

  await page.evaluate(`__t.task('second').querySelector('.task-text').click()`);
  await page.evaluate(`__t.type('.task-edit-input', 'second (edited)')`);
  await page.waitFor(`__t.task('second (edited)') !== undefined`);
  assert.deepEqual(op(), { type: 'task.update', task_ref: op().task_ref, task: { text: 'second (edited)' } });

  await page.evaluate(`__t.task('loose idea').querySelector('.btn-delete').click()`);
  await page.waitFor(`__t.task('loose idea') === undefined`);
  assert.equal(op().type, 'task.delete');
  assert.deepEqual(fake.markdownModel().find(([name]) => name === 'Inbox')[1], ['[ ] closed', '[ ] second (edited)', '[x] first']);
});

test('drag and drop and the move menu reorder through task.move and section.move', { skip }, async () => {
  await settle();
  await page.evaluate(`__t.drag(__t.task('closed'), __t.task('second (edited)'), 'after')`);
  await page.waitFor(`__t.model().find((s) => s.name === 'Inbox').tasks[0] === '[ ] second (edited)'`);
  assert.deepEqual(op(), { type: 'task.move', task_ref: op().task_ref, target_section_ref: op().target_section_ref, index: 1 });

  await page.evaluate(`__t.drag(__t.task('report'), __t.task('closed'), 'before')`);
  await page.waitFor(`__t.model().find((s) => s.name === 'Inbox').tasks.includes('[ ] report')`);
  assert.deepEqual((await model()).find((s) => s.name === 'Inbox').tasks, ['[ ] second (edited)', '[ ] report', '[ ] closed', '[x] first']);

  await page.evaluate(`__t.task('report').querySelector('.btn-move').click()`);
  await page.evaluate(`document.querySelector('.move-section-menu [data-section="Someday"]').click()`);
  await page.waitFor(`__t.model().find((s) => s.name === 'Someday').tasks[0] === '[ ] report'`);
  assert.equal(op().index, 0);

  await page.evaluate(`__t.drag(__t.section('Inbox'), __t.section('Someday'), 'before')`);
  await page.waitFor(`__t.model()[0].name === 'Inbox'`);
  assert.equal(op().type, 'section.move');
  assert.deepEqual(fake.markdownModel().map(([name]) => name), ['Inbox', 'Someday', 'Новая секция 1', 'Work']);
});

test('rename and delete section go through section.update and section.delete', { skip }, async () => {
  await settle();
  await page.evaluate(`__t.section('Новая секция 1').querySelector('.btn-rename-section').click()`);
  await page.evaluate(`__t.type('.section-rename-input', 'Ideas')`);
  await page.waitFor(`__t.section('Ideas') !== undefined`);
  assert.deepEqual(op(), { type: 'section.update', section_ref: op().section_ref, section: { name: 'Ideas' } });

  const count = fake.mutations().length;
  await page.evaluate(`__t.section('Ideas').querySelector('.btn-rename-section').click()`);
  await page.evaluate(`__t.type('.section-rename-input', 'Work')`);
  assert.equal(await page.evaluate(`document.getElementById('serverNoticeText').textContent`), 'Секция с таким именем уже есть.');
  assert.equal(fake.mutations().length, count);

  await page.evaluate(`__t.section('Ideas').querySelector('.btn-delete-section').click()`);
  await page.waitFor(`__t.section('Ideas') === undefined`);
  assert.deepEqual(op(), { type: 'section.delete', section_ref: op().section_ref, confirm: true });
});

test('a revision conflict rereads the document without replaying the operation', { skip }, async () => {
  await settle();
  fake.sections.find((section) => section.name === 'Work').tasks.unshift({ text: 'from another client', done: false, url: null });
  const count = fake.mutations().length;
  await page.evaluate(`__t.task('second (edited)').querySelector('.task-checkbox').click()`);
  await page.waitFor(`__t.task('from another client') !== undefined`, { timeout: 8000 });
  assert.equal(fake.mutations().length, count + 1, 'exactly one attempt, no replay');
  assert.equal(await page.evaluate(`__t.task('second (edited)').classList.contains('done')`), false);
  assert.match(await page.evaluate(`document.getElementById('serverNoticeText').textContent`), /Документ изменился/);
});

test('a lost response keeps the stable operation id and requires an explicit retry', { skip }, async () => {
  await settle();
  fake.failNext = { kind: 'lost-response' };
  await page.evaluate(`__t.task('second (edited)').querySelector('.task-checkbox').click()`);
  await page.waitFor(`document.getElementById('syncState').dataset.kind === 'retry'`);
  const lost = fake.mutations().at(-1).body;
  assert.equal(await page.evaluate(`__t.task('first').querySelector('.task-checkbox').disabled`), true);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(fake.mutations().at(-1).body.operation_id, lost.operation_id, 'nothing is replayed automatically');
  assert.equal(fake.mutations().filter((entry) => entry.body.operation_id === lost.operation_id).length, 1);

  await page.evaluate(`[...document.querySelectorAll('.server-notice-btn')].find((b) => b.textContent === 'повторить').click()`);
  await settle();
  const attempts = fake.mutations().filter((entry) => entry.body.operation_id === lost.operation_id);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].body, attempts[0].body);
  assert.equal(await page.evaluate(`__t.task('second (edited)').classList.contains('done')`), true);
});

test('offline shows the last snapshot read-only with bounded polling, then recovers', { skip }, async () => {
  await settle();
  fake.offline = true;
  const start = fake.log.length;
  await page.waitFor(`document.getElementById('syncState').dataset.kind === 'offline'`, { timeout: 6000 });
  assert.equal(await page.evaluate(`document.getElementById('syncState').textContent`), 'офлайн');
  assert.equal(await page.evaluate(`document.getElementById('legacyMode').classList.contains('readonly')`), true);
  assert.equal(await page.evaluate(`__t.task('first').querySelector('.task-checkbox').disabled`), true);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  assert.ok(fake.log.length - start <= 4, `backoff keeps requests rare: ${fake.log.length - start}`);
  fake.offline = false;
  await page.evaluate(`window.dispatchEvent(new Event('focus'))`);
  await settle();
  assert.equal(await page.evaluate(`document.getElementById('legacyMode').classList.contains('readonly')`), false);
});

test('idle polling revalidates with If-None-Match and picks up remote changes', { skip }, async () => {
  await settle();
  const start = fake.log.length;
  await new Promise((resolve) => setTimeout(resolve, 4500));
  const polls = fake.log.slice(start).filter((entry) => entry.path === '/api/v1/document');
  assert.ok(polls.length >= 1 && polls.length <= 3, `polls: ${polls.length}`);
  fake.sections[0].tasks.unshift({ text: 'remote arrival', done: false, url: null });
  await page.waitFor(`__t.task('remote arrival') !== undefined`, { timeout: 5000 });
});

const LONG_VOICE = 'Синтетическая голосовая заметка '.repeat(12).trim();

test('the Whisper inbox is pinned on top, marked, and protected from rename, delete and section drag', { skip }, async () => {
  await settle();
  fake.sections.push({ name: 'Неразобранные', tasks: [{ text: LONG_VOICE, done: false, url: null }, { text: 'short voice', done: false, url: null }] });
  await page.waitFor(`__t.section('Неразобранные') !== undefined`, { timeout: 6000 });
  assert.equal(fake.markdownModel().at(-1)[0], 'Неразобранные', 'server order is untouched');
  assert.equal((await model())[0].name, 'Неразобранные');
  assert.equal(await page.evaluate(`__t.section('Неразобранные').classList.contains('inbox')`), true);
  assert.equal(await page.evaluate(`__t.section('Неразобранные').getAttribute('draggable')`), 'false');
  assert.equal(await page.evaluate(`__t.section('Неразобранные').querySelector('.btn-rename-section, .btn-delete-section')`), null);
  assert.equal(await page.evaluate(`document.querySelector('#sectionSelectList .csel-item').dataset.value`), 'Неразобранные');

  const count = fake.mutations().length;
  await page.evaluate(`__t.drag(__t.section('Work'), __t.section('Неразобранные'), 'before')`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fake.mutations().length, count, 'dropping a section onto the pinned inbox does nothing');

  const names = (await model()).map((section) => section.name);
  const [first, second] = names.slice(1, 3);
  await page.evaluate(`__t.drag(__t.section(${JSON.stringify(second)}), __t.section(${JSON.stringify(first)}), 'before')`);
  await page.waitFor(`__t.model()[1].name === ${JSON.stringify(second)}`);
  assert.equal((await model())[0].name, 'Неразобранные');
  assert.equal(fake.markdownModel().at(-1)[0], 'Неразобранные');

  await page.evaluate(`__t.drag(__t.task('report') || __t.task('from another client'), __t.task('short voice'), 'after')`);
  await page.waitFor(`__t.model()[0].tasks.length === 3`);
});

test('long voice tasks can be edited by typing beyond the old 240 character limit', { skip }, async () => {
  await settle();
  assert.ok(LONG_VOICE.length > 240);
  await page.evaluate(`__t.task(${JSON.stringify(LONG_VOICE)}).querySelector('.task-text').click()`);
  await page.evaluate(`(() => { const input = document.querySelector('.task-edit-input'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); })()`);
  await page.send('Input.insertText', { text: ' дополнено' });
  await page.evaluate(`__t.key('.task-edit-input', 'Enter')`);
  await page.waitFor(`__t.task(${JSON.stringify(`${LONG_VOICE} дополнено`)}) !== undefined`);
  assert.equal(op().task.text, `${LONG_VOICE} дополнено`);

  await page.evaluate(`document.getElementById('taskInput').focus()`);
  await page.send('Input.insertText', { text: `${LONG_VOICE} новая` });
  assert.equal(await page.evaluate(`document.getElementById('taskInput').value.length`), LONG_VOICE.length + 6);
  await page.evaluate(`document.getElementById('taskInput').value = ''`);
});

test('✕ clear on notes.md only closes the local tab after confirmation and sends no mutation', { skip }, async () => {
  await settle();
  const count = fake.mutations().length;
  const serverBefore = JSON.stringify(fake.markdownModel());
  await page.evaluate(`__t.click('#clearDoneBtn')`);
  assert.equal(await page.evaluate('__dialogs.at(-1).message'), 'Вкладка будет закрыта, задачи останутся на сервере.');
  assert.equal((await page.evaluate('__t.tabs()')).some((name) => name.includes('notes.md')), false);
  assert.equal(fake.mutations().length, count);
  assert.equal(JSON.stringify(fake.markdownModel()), serverBefore);
  assert.equal(await page.evaluate(`document.getElementById('openServerTabBtn').hidden`), false);

  await reload(page);
  assert.equal((await page.evaluate('__t.tabs()')).some((name) => name.includes('notes.md')), false);
  await page.waitFor(`!document.getElementById('openServerTabBtn').hidden`);
  await page.evaluate(`__t.click('#openServerTabBtn')`);
  await page.waitFor(`__t.tabs().includes('*notes.md')`);
  await settle();
  assert.ok(await page.evaluate(`__t.task('remote arrival') !== undefined`));
});

test('the panel restores notes.md after reload without the content leaking into tabs storage', { skip }, async () => {
  await reload(page);
  await page.waitFor(`__t.tabs().includes('*notes.md')`);
  await settle();
  assert.ok(await page.evaluate(`__t.task('remote arrival') !== undefined`));
  const stored = await page.evaluate(`__t.storage(['tabs'])`);
  const serverTab = stored.tabs.find((tab) => tab.storage === 'notes-api');
  assert.deepEqual([serverTab.tasks, serverTab.sections], [[], []]);
});

test('no credential or pairing code leaks into DOM, sync/session storage, tabs or logs', { skip }, async () => {
  const credential = fake.credential;
  const secret = credential.split('.')[1];
  const dom = await page.evaluate('document.documentElement.outerHTML');
  assert.equal(dom.includes(secret), false);
  const sync = await page.evaluate('chrome.storage.sync.get(null)');
  const session = await page.evaluate('chrome.storage.session.get(null)');
  assert.deepEqual(sync, {});
  assert.equal(JSON.stringify(session).includes(secret), false);
  const local = await page.evaluate('chrome.storage.local.get(null)');
  const holders = Object.entries(local).filter(([, value]) => JSON.stringify(value).includes(secret)).map(([key]) => key);
  assert.deepEqual(holders, ['notesApiCredentialV1']);
  assert.equal(consoleLines.some((line) => line.includes(secret)), false);
  assert.equal(consoleLines.some((line) => /syn-[0-9a-f-]{13}/.test(line)), false);
});

test('a revoked host permission drops the stale notes.md tab instead of leaving a dead tab', { skip }, async () => {
  const stored = await page.evaluate(`__t.storage(null)`);
  await page.evaluate(`(() => {
    const realContains = chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains = (permission, callback) => callback(false);
    window.__restoreContains = () => { chrome.permissions.contains = realContains; };
  })()`);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'chrome.permissions.contains = (p, cb) => cb(false);' }).then(({ identifier }) => { page.revokedScript = identifier; });
  await reload(page);
  await page.waitFor(`!__t.tabs().some((name) => name.includes('notes.md'))`);
  assert.equal(await page.evaluate(`document.getElementById('apiModeToggle').checked`), false);
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.revokedScript });
  await reloadWithStorage(page, stored);
  await page.waitFor(`__t.tabs().some((name) => name.includes('notes.md'))`);
  await settle();
});

test('switching Notes API off restores the plain legacy UI and stops talking to the server', { skip }, async () => {
  await page.evaluate(`chrome.permissions.remove = (permission, callback) => callback(true)`);
  await page.evaluate(`__t.click('#apiModeToggle')`);
  await page.waitFor(`!__t.tabs().some((name) => name.includes('notes.md'))`);
  assert.equal(await page.evaluate(`document.getElementById('syncState').hidden`), true);
  assert.equal(await page.evaluate(`document.getElementById('serverNotice').hidden`), true);
  await page.evaluate(`__t.tab('dop.md').click()`);
  assert.equal(await page.evaluate(`__t.task('legacy item').querySelector('.task-checkbox').disabled`), false);
  assert.equal(await page.evaluate(`document.querySelector('.bc-path').textContent`), '~/tasks/');
  const start = fake.log.length;
  await reload(page);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(fake.log.length, start);
  assert.deepEqual(await page.evaluate('__t.tabs()'), ['work.md', '*dop.md']);
});
