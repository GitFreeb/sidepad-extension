// Характеризация привычного Sidepad UI в настоящем браузере. Эти сценарии
// фиксируют поведение файловых вкладок до и после объединения с Notes API.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Browser, browserExecutable, recordRequests } from './cdp.mjs';
import { legacyTab, openPopup, reload, reloadWithStorage } from './popup-helpers.mjs';

const executable = browserExecutable();
const skip = executable ? false : 'Chromium-based browser is not available';
const popupCss = readFileSync(new URL('../../popup.css', import.meta.url), 'utf8');

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

test('task cards give text the full control width with compact aligned controls and hyphenation', { skip }, async () => {
  assert.match(popupCss, /-webkit-hyphens:\s*auto;/);
  await reloadWithStorage(page, seed());
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 720, deviceScaleFactor: 1, mobile: false });

  const layout = await page.evaluate(`(() => {
    const row = __t.task('one');
    const handle = row.querySelector('.drag-handle');
    const checkbox = row.querySelector('.task-checkbox');
    const actions = row.querySelector('.task-actions');
    const text = row.querySelector('.task-text');
    if (!actions) return { hasActions: false };

    const rowRect = row.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    const checkboxRect = checkbox.getBoundingClientRect();
    const actionRects = [...actions.querySelectorAll('button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const actionsRect = actions.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    const textStyle = getComputedStyle(text);
    return {
      hasActions: true,
      handleLeftInset: handleRect.left - rowRect.left,
      handleCenterDelta: Math.abs((handleRect.top + handleRect.height / 2) - (rowRect.top + rowRect.height / 2)),
      handleHeight: handleRect.height,
      checkboxWidth: checkboxRect.width,
      checkboxHeight: checkboxRect.height,
      textLeftDelta: Math.abs(textRect.left - checkboxRect.left),
      textRightDelta: Math.abs(textRect.right - actionsRect.right),
      textBelowControls: textRect.top >= Math.max(checkboxRect.bottom, actionsRect.bottom) + 3,
      rightInset: rowRect.right - actionsRect.right,
      actionRects,
      hyphens: textStyle.hyphens,
      overflowWrap: textStyle.overflowWrap,
      textAlign: textStyle.textAlign,
      horizontalOverflow: row.scrollWidth > row.clientWidth,
    };
  })()`);

  assert.equal(layout.hasActions, true);
  assert.ok(layout.handleLeftInset <= 6, `drag handle inset is ${layout.handleLeftInset}px`);
  assert.ok(layout.handleCenterDelta <= 1.5, `drag handle is ${layout.handleCenterDelta}px off centre`);
  assert.ok(layout.handleHeight < 24, `drag handle unexpectedly spans ${layout.handleHeight}px`);
  assert.equal(layout.checkboxWidth, 14);
  assert.equal(layout.checkboxHeight, 14);
  assert.ok(layout.textLeftDelta <= 1.5, `text starts ${layout.textLeftDelta}px away from the checkbox stack`);
  assert.ok(layout.textRightDelta <= 1.5, `text ends ${layout.textRightDelta}px away from the action edge`);
  assert.equal(layout.textBelowControls, true);
  assert.ok(layout.rightInset >= 3 && layout.rightInset <= 5, `right inset is ${layout.rightInset}px`);
  assert.ok(layout.actionRects.length >= 2);
  assert.ok(layout.actionRects.every(({ width, height }) => width === 18 && height === 18));
  assert.equal(layout.hyphens, 'auto');
  assert.equal(layout.overflowWrap, 'anywhere');
  assert.equal(layout.textAlign, 'left');
  assert.equal(layout.horizontalOverflow, false);

  await page.send('Emulation.clearDeviceMetricsOverride');
});

test('first task hover keeps the section gap and left accent', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 640, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    document.querySelector('#sectionSelectList [data-value="Alpha"]')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()`);
  const point = await page.evaluate(`(() => {
    const rect = __t.task('one').getBoundingClientRect();
    return { x: rect.left + 40, y: rect.top + 20 };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const state = await page.evaluate(`(() => {
    const header = __t.section('Alpha');
    const task = __t.task('one');
    const cover = getComputedStyle(header, '::after');
    const taskStyle = getComputedStyle(task);
    return {
      front: header.classList.contains('sticky-cover-front'),
      hovered: task.matches(':hover'),
      gap: task.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
      coverHeight: parseFloat(cover.height),
      coverBackground: cover.backgroundColor,
      coverBorder: cover.borderLeftColor,
      taskBackground: taskStyle.backgroundColor,
      taskBorder: taskStyle.borderLeftColor,
    };
  })()`);
  assert.equal(state.front, true, JSON.stringify(state));
  assert.equal(state.hovered, true, JSON.stringify(state));
  assert.ok(Math.abs(state.gap - 2) <= 1, JSON.stringify(state));
  assert.ok(state.coverHeight > 0, JSON.stringify(state));
  assert.equal(state.coverBackground, state.taskBackground, JSON.stringify(state));
  assert.equal(state.coverBorder, state.taskBorder, JSON.stringify(state));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await page.send('Emulation.clearDeviceMetricsOverride');
});

test('section picker shows and refreshes incomplete over total task counts', { skip }, async () => {
  await reloadWithStorage(page, seed());
  const pickerCounts = () => page.evaluate(`Object.fromEntries(
    [...document.querySelectorAll('#sectionSelectList .csel-item')].map((item) => [item.dataset.value, {
      value: item.querySelector('.csel-count').textContent,
      title: item.querySelector('.csel-count').title,
      children: item.querySelector('.csel-count').childElementCount,
    }])
  )`);

  assert.deepEqual(await pickerCounts(), {
    Alpha: { value: '2/3', title: 'Незавершённых: 2 из 3', children: 0 },
    Beta: { value: '1/1', title: 'Незавершённых: 1 из 1', children: 0 },
  });

  await page.evaluate(`__t.task('one').querySelector('.task-checkbox').click()`);
  assert.deepEqual((await pickerCounts()).Alpha, {
    value: '1/3',
    title: 'Незавершённых: 1 из 3',
    children: 0,
  });
});

test('keeps the successful target selected for rapid task capture', { skip }, async () => {
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
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Beta');

  await page.evaluate(`__t.type('#taskInput', 'second')`);
  current = await model();
  assert.deepEqual(current[1].tasks, ['[ ] second', '[ ] fresh', '[ ] four']);
  assert.equal(current.some((section) => section.name === 'Новая секция 1'), false);

  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.type('#taskInput', 'orphan')`);
  current = await model();
  assert.equal(current[0].name, 'Новая секция 1');
  assert.deepEqual(current[0].tasks, ['[ ] orphan']);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Новая секция 1');

  await page.evaluate(`__t.type('#taskInput', 'orphan follow-up')`);
  current = await model();
  assert.deepEqual(current[0].tasks, ['[ ] orphan follow-up', '[ ] orphan']);

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
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Named');
});

test('section selection reveals its header at the top with uniform gaps and a shaded canvas', { skip }, async () => {
  const alphaTasks = Array.from({ length: 18 }, (_, index) => `alpha ${index + 1}`);
  await reloadWithStorage(page, {
    tabs: [legacyTab('tab_navigation', 'navigation', [
      ['Alpha', alphaTasks],
      ['Beta', ['beta one', 'beta two']],
      ['Gamma', ['gamma one']],
    ])],
    activeTabId: 'tab_navigation',
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 640, deviceScaleFactor: 1, mobile: false });

  await page.evaluate(`(() => {
    __t.section('Beta').click();
    const list = document.getElementById('taskList');
    list.scrollTop = 0;
    document.getElementById('taskInput').value = 'draft task';
    document.getElementById('linkInput').value = 'https://example.test/draft';
    __t.click('#sectionSelect');
    document.querySelector('#sectionSelectList [data-value="Beta"]')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 900));

  const state = await page.evaluate(`(() => {
    const list = document.getElementById('taskList');
    const header = __t.section('Beta');
    const otherHeader = __t.section('Alpha');
    const nextHeader = __t.section('Gamma');
    const group = header.closest('.section-group');
    const body = group.querySelector('.section-body');
    const contentCanvas = group.querySelector('.section-content');
    const nextBody = nextHeader.closest('.section-body');
    const listStyle = getComputedStyle(list);
    const headerStyle = getComputedStyle(header);
    const expectedTop = list.getBoundingClientRect().top
      + parseFloat(listStyle.paddingTop)
      + parseFloat(headerStyle.top);
    const content = [...group.querySelectorAll('.task-item, .section-empty')];
    const probe = document.createElement('span');
    probe.style.background = 'var(--section-target-bg)';
    document.body.append(probe);
    const targetBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      topDelta: Math.abs(header.getBoundingClientRect().top - expectedTop),
      collapsed: header.classList.contains('collapsed'),
      targetGroups: document.querySelectorAll('.section-group.section-picker-target').length,
      groupTargeted: group.classList.contains('section-picker-target'),
      headerTargeted: header.classList.contains('section-picker-target'),
      headerBackground: headerStyle.backgroundColor,
      otherHeaderBackground: getComputedStyle(otherHeader).backgroundColor,
      bodyBackground: getComputedStyle(body).backgroundColor,
      contentCanvasBackground: getComputedStyle(contentCanvas).backgroundColor,
      nextHeaderUnderlay: getComputedStyle(nextBody).backgroundImage,
      headerTopRadius: headerStyle.borderTopLeftRadius,
      headerBottomRadius: headerStyle.borderBottomLeftRadius,
      nextHeaderTopRadius: getComputedStyle(nextHeader).borderTopLeftRadius,
      nextHeaderBottomRadius: getComputedStyle(nextHeader).borderBottomLeftRadius,
      contentBackgrounds: content.map((item) => getComputedStyle(item).backgroundColor),
      targetBackground,
      leftDelta: Math.abs(contentCanvas.getBoundingClientRect().left - header.getBoundingClientRect().left),
      rightDelta: Math.abs(contentCanvas.getBoundingClientRect().right - header.getBoundingClientRect().right),
      topGap: Math.abs(contentCanvas.getBoundingClientRect().top - header.getBoundingClientRect().bottom),
      bottomGap: Math.abs(nextHeader.getBoundingClientRect().top - contentCanvas.getBoundingClientRect().bottom),
      taskDraft: document.getElementById('taskInput').value,
      linkDraft: document.getElementById('linkInput').value,
    };
  })()`);

  assert.ok(state.topDelta <= 1.5, `selected section header missed the top by ${state.topDelta}px`);
  assert.equal(state.collapsed, false);
  assert.equal(state.targetGroups, 1);
  assert.equal(state.groupTargeted, true);
  assert.equal(state.headerTargeted, false);
  assert.equal(state.headerBackground, state.otherHeaderBackground);
  assert.equal(state.bodyBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(state.contentCanvasBackground, state.targetBackground);
  assert.equal(state.nextHeaderUnderlay, 'none');
  assert.equal(state.headerTopRadius, '6px');
  assert.equal(state.headerBottomRadius, '6px');
  assert.equal(state.nextHeaderTopRadius, '6px');
  assert.equal(state.nextHeaderBottomRadius, '6px');
  assert.ok(state.contentBackgrounds.every((background) => background === 'rgba(0, 0, 0, 0)'));
  assert.ok(state.leftDelta <= 1, `content canvas starts ${state.leftDelta}px away from the header`);
  assert.ok(state.rightDelta <= 1, `content canvas ends ${state.rightDelta}px away from the header`);
  assert.ok(Math.abs(state.topGap - 2) <= 1, `content canvas starts ${state.topGap}px below the header`);
  assert.ok(Math.abs(state.bottomGap - 2) <= 1, `content canvas ends ${state.bottomGap}px before the next header`);
  assert.equal(state.taskDraft, 'draft task');
  assert.equal(state.linkDraft, 'https://example.test/draft');
  assert.deepEqual((await model())[1].tasks, ['[ ] beta one', '[ ] beta two']);

  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    document.querySelector('#sectionSelectList [data-value="Gamma"]')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 900));
  const lastState = await page.evaluate(`(() => {
    const header = __t.section('Gamma');
    const content = header.closest('.section-group').querySelector('.section-content');
    const headerStyle = getComputedStyle(header);
    const contentStyle = getComputedStyle(content);
    return {
      lastClass: header.closest('.section-group').classList.contains('section-last'),
      headerTopRadius: headerStyle.borderTopLeftRadius,
      headerBottomRadius: headerStyle.borderBottomLeftRadius,
      contentTopRadius: contentStyle.borderTopLeftRadius,
      contentBottomRadius: contentStyle.borderBottomLeftRadius,
    };
  })()`);
  assert.deepEqual(lastState, {
    lastClass: true,
    headerTopRadius: '6px',
    headerBottomRadius: '6px',
    contentTopRadius: '6px',
    contentBottomRadius: '6px',
  });

  await page.send('Emulation.clearDeviceMetricsOverride');
});

test('stores an explicit default section per file tab without replacing sticky selection', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    [...document.querySelectorAll('#sectionSelectList .csel-item')].find((li) => li.dataset.value === 'Beta')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.click('#defaultSectionBtn');
  })()`);

  assert.deepEqual((await page.evaluate(`__t.storage(['sidepadDefaultSectionsV1'])`)).sidepadDefaultSectionsV1, { tab_work: 'Beta' });
  assert.equal(await page.evaluate(`document.getElementById('defaultSectionBtn').getAttribute('aria-pressed')`), 'true');
  assert.equal(await page.evaluate(`document.querySelector('#sectionSelectList [data-value="Beta"]').classList.contains('default')`), true);

  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    [...document.querySelectorAll('#sectionSelectList .csel-item')].find((li) => li.dataset.value === 'Alpha')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.type('#taskInput', 'temporary target');
    __t.type('#taskInput', 'temporary follow-up');
  })()`);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Alpha');
  assert.deepEqual((await page.evaluate(`__t.storage(['sidepadDefaultSectionsV1'])`)).sidepadDefaultSectionsV1, { tab_work: 'Beta' });

  await page.evaluate(`(() => {
    __t.type('#sectionInput', 'Named Once', null);
    __t.type('#taskInput', 'named precedence');
  })()`);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Named Once');
  assert.equal((await page.evaluate(`__t.storage(['sidepadDefaultSectionsV1'])`)).sidepadDefaultSectionsV1.tab_work, 'Beta');

  await page.evaluate(`__t.tab('dop.md').click()`);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Выбор секции');
  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    document.querySelector('#sectionSelectList [data-value="Old"]')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.click('#defaultSectionBtn');
    __t.tab('work.md').click();
  })()`);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Beta');
  assert.deepEqual((await page.evaluate(`__t.storage(['sidepadDefaultSectionsV1'])`)).sidepadDefaultSectionsV1, {
    tab_work: 'Beta',
    tab_dop: 'Old',
  });

  await reload(page);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Beta');
  await page.evaluate(`(() => {
    __t.section('Beta').querySelector('.btn-rename-section').click();
    __t.type('.section-rename-input', 'Focus');
  })()`);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Focus');
  assert.equal((await page.evaluate(`__t.storage(['sidepadDefaultSectionsV1'])`)).sidepadDefaultSectionsV1.tab_work, 'Focus');

  await page.evaluate(`__t.click('#langBtn')`);
  assert.match(await page.evaluate(`document.getElementById('defaultSectionBtn').title`), /default/i);
  await page.evaluate(`__t.click('#defaultSectionBtn')`);
  assert.equal(Object.hasOwn((await page.evaluate(`__t.storage(['sidepadDefaultSectionsV1'])`)).sidepadDefaultSectionsV1, 'tab_work'), false);

  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    document.querySelector('#sectionSelectList [data-value="Focus"]')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.click('#defaultSectionBtn');
    __t.section('Focus').querySelector('.btn-delete-section').click();
  })()`);
  const afterDelete = (await page.evaluate(`__t.storage(['sidepadDefaultSectionsV1'])`)).sidepadDefaultSectionsV1;
  assert.equal(Object.hasOwn(afterDelete, 'tab_work'), false);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Select section');
});

test('adding an active task expands only its collapsed target section', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`(() => {
    __t.click('#collapseAllBtn');
    __t.click('#sectionSelect');
    [...document.querySelectorAll('#sectionSelectList .csel-item')].find((li) => li.dataset.value === 'Beta')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.type('#taskInput', 'fresh');
  })()`);

  assert.deepEqual(await model(), [
    { name: 'Alpha', collapsed: true, tasks: [] },
    { name: 'Beta', collapsed: false, tasks: ['[ ] fresh', '[ ] four'] },
  ]);
  assert.equal(await page.evaluate(`document.getElementById('sectionSelectVal').textContent`), 'Beta');
  assert.equal(await page.evaluate(`document.getElementById('collapseAllBtn').textContent`), '▸ свернуть');
});

test('toggle moves a finished task to the end and a reopened task to the top', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.task('one').querySelector('.task-checkbox').click()`);
  assert.deepEqual((await model())[0].tasks, ['[ ] two', '[x] three', '[x] one']);
  await page.evaluate(`__t.task('three').querySelector('.task-checkbox').click()`);
  assert.deepEqual((await model())[0].tasks, ['[ ] three', '[ ] two', '[x] one']);
  assert.equal(await page.evaluate(`document.getElementById('counter').textContent`), '1 / 4');
});

test('checkbox click tolerates small pointer movement without starting task drag', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`(() => {
    window.__taskDragStarts = 0;
    document.getElementById('taskList').addEventListener('dragstart', (event) => {
      if (event.target.closest('.task-item')) window.__taskDragStarts += 1;
    });
  })()`);
  const point = await page.evaluate(`(() => {
    const rect = __t.task('one').querySelector('.task-checkbox').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);

  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x + 3, y: point.y, button: 'left', buttons: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x + 3, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });

  await page.waitFor(`__t.model()[0].tasks.includes('[x] one')`);
  assert.equal(await page.evaluate('window.__taskDragStarts'), 0);
  assert.deepEqual(await page.evaluate(`(() => {
    const task = __t.task('one');
    return { row: task.draggable, handle: task.querySelector('.drag-handle').draggable };
  })()`), { row: false, handle: true });
});

test('completed tasks stay in a compact count group without collapsing their section', { skip }, async () => {
  await reloadWithStorage(page, seed());
  assert.deepEqual(await page.evaluate(`(() => {
    const group = __t.section('Alpha').closest('.section-group').querySelector('.done-group');
    return {
      summary: group.querySelector('summary').textContent.trim(),
      open: group.open,
      closedTaskVisible: __t.task('three').getClientRects().length > 0,
    };
  })()`), { summary: 'Выполненные · 1', open: false, closedTaskVisible: false });

  await page.evaluate(`__t.section('Alpha').closest('.section-group').querySelector('.done-group summary').click()`);
  assert.equal(await page.evaluate(`__t.task('three').getClientRects().length > 0`), true);
  await page.evaluate(`__t.task('one').querySelector('.task-checkbox').click()`);
  assert.deepEqual(await page.evaluate(`(() => {
    const group = __t.section('Alpha').closest('.section-group').querySelector('.done-group');
    return { summary: group.querySelector('summary').textContent.trim(), open: group.open };
  })()`), { summary: 'Выполненные · 2', open: true });

  await page.evaluate(`__t.task('four').querySelector('.task-checkbox').click()`);
  assert.deepEqual((await model())[1], { name: 'Beta', collapsed: false, tasks: ['[x] four'] });
  assert.deepEqual(await page.evaluate(`(() => {
    const group = __t.section('Beta').closest('.section-group').querySelector('.done-group');
    return {
      summary: group.querySelector('summary').textContent.trim(),
      open: group.open,
      taskVisible: __t.task('four').getClientRects().length > 0,
    };
  })()`), { summary: 'Выполненные · 1', open: false, taskVisible: false });
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

test('task drag keeps the handle as the initiator but previews the whole task card', { skip }, async () => {
  await reloadWithStorage(page, seed());
  const feedback = await page.evaluate(`(async () => {
    const row = __t.task('one');
    const handle = row.querySelector('.drag-handle');
    const handleRect = handle.getBoundingClientRect();
    const original = DataTransfer.prototype.setDragImage;
    let captured = null;

    DataTransfer.prototype.setDragImage = function (element, x, y) {
      captured = {
        isTask: element === row,
        isHandle: element === handle,
        x,
        y,
        width: element.getBoundingClientRect().width,
        rowWidth: row.getBoundingClientRect().width,
      };
    };

    try {
      const dataTransfer = new DataTransfer();
      handle.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: handleRect.left + handleRect.width / 2,
        clientY: handleRect.top + handleRect.height / 2,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      return captured;
    } finally {
      DataTransfer.prototype.setDragImage = original;
    }
  })()`);

  assert.equal(feedback?.isTask, true);
  assert.equal(feedback?.isHandle, false);
  assert.equal(feedback?.width, feedback?.rowWidth);
  assert.ok(feedback?.x >= 0 && feedback?.x <= 20, `unexpected horizontal anchor ${feedback?.x}`);
  assert.ok(feedback?.y >= 0, `unexpected vertical anchor ${feedback?.y}`);
});

test('drag and drop reorders tasks, moves them between sections and reorders sections', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.drag(__t.task('one').querySelector('.drag-handle'), __t.task('two'), 'after')`);
  assert.deepEqual((await model())[0].tasks, ['[ ] two', '[ ] one', '[x] three']);

  await page.evaluate(`__t.drag(__t.task('two').querySelector('.drag-handle'), __t.task('four'), 'after')`);
  let current = await model();
  assert.deepEqual(current[0].tasks, ['[ ] one', '[x] three']);
  assert.deepEqual(current[1].tasks, ['[ ] four', '[ ] two']);

  await page.evaluate(`__t.drag(__t.task('four').querySelector('.drag-handle'), __t.section('Alpha'))`);
  current = await model();
  assert.deepEqual(current[0].tasks, ['[ ] one', '[ ] four', '[x] three']);

  await page.evaluate(`__t.drag(__t.section('Beta'), __t.section('Alpha'), 'before')`);
  assert.deepEqual((await model()).map((s) => s.name), ['Beta', 'Alpha']);
});

test('collapse all toggles every section and expands every section again', { skip }, async () => {
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

test('local timestamps survive edit, toggle, move and canonical Markdown round-trips', { skip }, async () => {
  await reloadWithStorage(page, seed());
  assert.equal(await page.evaluate(`__t.task('one').querySelector('.task-created')`), null);

  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    document.querySelector('#sectionSelectList [data-value="Alpha"]')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.type('#taskInput', 'timestamped');
  })()`);
  const createdAt = await page.evaluate(`__t.task('timestamped').querySelector('.task-created').dateTime`);
  assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(await page.evaluate(`__t.task('timestamped').querySelector('.task-created').textContent.includes('Invalid')`), false);
  assert.equal(await page.evaluate(`__t.task('timestamped').querySelector('.task-created').textContent`), await page.evaluate(`new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(${JSON.stringify(createdAt)}))`));

  await page.evaluate(`(() => {
    __t.task('timestamped').querySelector('.task-text').click();
    __t.type('.task-edit-input', 'timestamped edited');
    __t.task('timestamped edited').querySelector('.task-checkbox').click();
    __t.task('timestamped edited').querySelector('.btn-move').click();
    document.querySelector('.move-section-menu [data-section="Beta"]').click();
  })()`);
  assert.equal(await page.evaluate(`__t.task('timestamped edited').querySelector('.task-created').dateTime`), createdAt);
  assert.equal(await page.evaluate(`__t.task('timestamped edited').classList.contains('done')`), true);

  const markdown = await page.evaluate(`generateMd()`);
  const encoded = encodeURIComponent(createdAt);
  assert.ok(markdown.includes(`- [x] timestamped edited\n<!-- notes-lab:created-at=${encoded} -->`));
  const roundTrip = await page.evaluate(`parseMd(${JSON.stringify(markdown)}, 'work.md').find((task) => task.text === 'timestamped edited').createdAt`);
  assert.equal(roundTrip, createdAt);

  const autoSyncRoundTrip = await page.evaluate(`(async () => {
    let contents = '';
    const handle = {
      async createWritable() {
        return {
          async write(value) { contents = value; },
          async close() {},
        };
      },
      async getFile() {
        return { lastModified: 1, async text() { return contents; } };
      },
    };
    const tab = getActiveTab();
    await writeTabToHandle(handle, tab);
    const started = await startSync(tab, handle);
    stopSync(tab.id);
    return { started, createdAt: tab.tasks.find((task) => task.text === 'timestamped edited').createdAt };
  })()`);
  assert.deepEqual(autoSyncRoundTrip, { started: true, createdAt });

  await page.evaluate(`__t.click('#langBtn')`);
  assert.equal(await page.evaluate(`__t.task('timestamped edited').querySelector('.task-created').textContent`), await page.evaluate(`new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(${JSON.stringify(createdAt)}))`));

  const invalid = await page.evaluate(`parseMd('# bad\\n\\n## Inbox\\n\\n<!-- arbitrary=value -->\\n- [ ] legacy\\n<!-- notes-lab:created-at=broken -->\\n<!-- notes-lab:unknown=x -->', 'bad.md')`);
  assert.deepEqual(invalid.map((task) => ({ section: task.section, text: task.text, createdAt: task.createdAt })), [
    { section: 'Inbox', text: 'legacy', createdAt: undefined },
  ]);
});

test('task metadata blocks keep created-at after flagged and stop at invalid or structural boundaries', { skip }, async () => {
  await reloadWithStorage(page, seed());
  const createdAt = '2026-11-17T08:09:10.123Z';
  const encoded = encodeURIComponent(createdAt);
  const canonical = `# flagged\n\n## Inbox\n\n- [ ] Flagged task\n<!-- notes-lab:flagged=true -->\n<!-- notes-lab:created-at=${encoded} -->\n- [ ] Created only\n<!-- notes-lab:created-at=${encoded} -->`;
  await page.evaluate(`(() => {
    const input = document.getElementById('importFileInput');
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(canonical)}], 'flagged.md', { type: 'text/markdown' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor(`__t.tabs().includes('*flagged.md')`);
  assert.equal(await page.evaluate(`__t.task('Flagged task').querySelector('.task-created').dateTime`), createdAt);
  assert.equal(await page.evaluate(`__t.task('Created only').querySelector('.task-created').dateTime`), createdAt);
  assert.equal(await page.evaluate(`__t.task('Flagged task').querySelector('.task-created').textContent.includes('Invalid')`), false);

  const exported = await page.evaluate(`generateMd()`);
  assert.ok(exported.includes(`- [ ] Flagged task\n<!-- notes-lab:created-at=${encoded} -->`));
  assert.equal(exported.includes('notes-lab:flagged='), false, 'Sidepad does not add a flag model or flag metadata');

  const invalid = `# invalid\n\n## Inbox\n\n- [ ] Bad flag\n<!-- notes-lab:flagged=maybe -->\n<!-- notes-lab:created-at=${encoded} -->\n- [ ] Bad date\n<!-- notes-lab:created-at=broken -->\n<!-- notes-lab:created-at=${encoded} -->\n- [ ] Unrelated\n<!-- arbitrary=value -->\n<!-- notes-lab:created-at=${encoded} -->\n- [ ] Blank boundary\n\n<!-- notes-lab:created-at=${encoded} -->\n- [ ] Heading boundary\n## Later\n<!-- notes-lab:created-at=${encoded} -->\n- [ ] Next-task source\n<!-- notes-lab:flagged=true -->\n- [ ] Next task\n<!-- notes-lab:created-at=${encoded} -->`;
  const parsed = await page.evaluate(`parseMd(${JSON.stringify(invalid)}, 'invalid.md')`);
  assert.deepEqual(parsed.map((task) => ({ section: task.section, text: task.text, createdAt: task.createdAt })), [
    { section: 'Inbox', text: 'Bad flag', createdAt: undefined },
    { section: 'Inbox', text: 'Bad date', createdAt: undefined },
    { section: 'Inbox', text: 'Unrelated', createdAt: undefined },
    { section: 'Inbox', text: 'Blank boundary', createdAt: undefined },
    { section: 'Inbox', text: 'Heading boundary', createdAt: undefined },
    { section: 'Later', text: 'Next-task source', createdAt: undefined },
    { section: 'Later', text: 'Next task', createdAt },
  ]);
});

test('language switch re-renders the static UI in English', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`__t.click('#langBtn')`);
  assert.equal(await page.evaluate(`document.getElementById('addBtn').textContent`), '+ add');
  assert.equal(await page.evaluate(`document.getElementById('clearDoneBtn').textContent`), '✕ clear');
  assert.equal(await page.evaluate(`document.querySelector('.done-group summary').textContent.trim()`), 'Completed · 1');
});

test('light contrast stays hierarchical and all supported panel widths avoid horizontal overflow', { skip }, async () => {
  await reloadWithStorage(page, seed());
  await page.evaluate(`(() => {
    __t.click('#sectionSelect');
    document.querySelector('#sectionSelectList [data-value="Alpha"]')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    __t.type('#linkInput', 'https://example.test/a-very-long-path-that-must-not-overflow', null);
    __t.type('#taskInput', 'contrast sample');
  })()`);

  const styles = () => page.evaluate(`(() => {
    const task = getComputedStyle(__t.task('contrast sample').querySelector('.task-text'));
    const time = getComputedStyle(__t.task('contrast sample').querySelector('.task-created'));
    return {
      task: { color: task.color, fontSize: task.fontSize, fontWeight: task.fontWeight, lineHeight: task.lineHeight },
      time: { color: time.color, fontSize: time.fontSize, fontWeight: time.fontWeight },
    };
  })()`);
  const darkBefore = await styles();
  assert.deepEqual(darkBefore.task, { color: 'rgb(255, 255, 255)', fontSize: '12px', fontWeight: '400', lineHeight: '18px' });

  await page.evaluate(`__t.click('#themeBtn')`);
  const light = await styles();
  assert.equal(light.task.fontWeight, '500');
  assert.notEqual(light.task.color, light.time.color);
  assert.ok(parseFloat(light.time.fontSize) < parseFloat(light.task.fontSize));

  for (const [width, height] of [[320, 720], [768, 1024], [960, 720]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (let language = 0; language < 2; language += 1) {
      const layout = await page.evaluate(`(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        taskRight: __t.task('contrast sample').getBoundingClientRect().right,
        offenders: [...document.querySelectorAll('body *')]
          .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
          .slice(0, 8)
          .map((element) => ({ tag: element.tagName, id: element.id, className: element.className, right: element.getBoundingClientRect().right })),
      }))()`);
      assert.ok(layout.page <= layout.viewport, `document overflow at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.body <= layout.viewport, `body overflow at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.taskRight <= layout.viewport, `task overflow at ${width}px: ${JSON.stringify(layout)}`);
      await page.evaluate(`__t.click('#langBtn')`);
    }
  }

  await page.evaluate(`__t.click('#themeBtn')`);
  assert.deepEqual(await styles(), darkBefore, 'dark typography and colors stay unchanged');
  await page.send('Emulation.clearDeviceMetricsOverride');
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

test('sticky section headers never pile up or cover their first task after scrolling and expanding', { skip }, async () => {
  const sections = Array.from({ length: 8 }, (_, s) => [`S${s}`, Array.from({ length: 6 }, (_, t) => `task ${s}.${t}`)]);
  await reloadWithStorage(page, { tabs: [legacyTab('tab_long', 'long', sections)], activeTabId: 'tab_long' });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 640, deviceScaleFactor: 1, mobile: false });
  const overlaps = () => page.evaluate(`(() => {
    const list = document.getElementById('taskList');
    const top = list.getBoundingClientRect().top;
    const headers = [...list.querySelectorAll('.section-header')].map((h) => h.getBoundingClientRect())
      .filter((r) => r.bottom > top && r.height > 0);
    let pile = 0;
    for (let i = 0; i < headers.length; i += 1) {
      for (let j = i + 1; j < headers.length; j += 1) {
        if (headers[i].top < headers[j].bottom - 1 && headers[j].top < headers[i].bottom - 1) pile += 1;
      }
    }
    const covered = [...list.querySelectorAll('.section-header')].filter((h) => {
      const r = h.getBoundingClientRect();
      const first = h.parentElement.querySelector('.task-item') && [...list.querySelectorAll('.task-item')]
        .find((li) => li.querySelector('.task-text')?.textContent === 'task ' + h.dataset.section.slice(1) + '.0');
      if (!first || r.bottom <= top) return false;
      const f = first.getBoundingClientRect();
      // Первая задача видна сразу под плашкой: не под ней и не выше края списка.
      return f.top < r.bottom - 1;
    }).length;
    return { pile, covered };
  })()`);
  for (const ratio of [0.35, 0.7, 1]) {
    await page.evaluate(`(() => { const l = document.getElementById('taskList'); l.scrollTop = (l.scrollHeight - l.clientHeight) * ${ratio}; })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await overlaps()).pile, 0, `headers pile up at scroll ${ratio}`);
  }
  for (let i = 0; i < 3; i += 1) {
    // Прокрутка внутрь секции: её плашка уже прилипла к верху списка.
    await page.evaluate(`(() => {
      const l = document.getElementById('taskList');
      const group = __t.section('S5').parentElement;
      l.scrollTop += group.getBoundingClientRect().top - l.getBoundingClientRect().top + 60;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const corridor = await page.evaluate(`(() => {
      const list = document.getElementById('taskList').getBoundingClientRect();
      const header = __t.section('S5').getBoundingClientRect();
      const hit = document.elementFromPoint(header.left + 40, (list.top + header.top) / 2);
      return {
        gap: header.top - list.top,
        hitClass: hit?.className || '',
        occludedByToolbar: hit?.classList.contains('toolbar') || false,
      };
    })()`);
    assert.ok(corridor.gap >= 9.5 && corridor.gap <= 10.5, JSON.stringify(corridor));
    assert.equal(corridor.occludedByToolbar, true, JSON.stringify(corridor));
    await page.evaluate(`__t.section('S5').click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await page.evaluate(`__t.section('S5').click()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepEqual(await overlaps(), { pile: 0, covered: 0 }, `after collapse/expand #${i + 1}`);
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
});

test('the top edge hides previous content throughout a section handoff', { skip }, async () => {
  const sections = Array.from({ length: 5 }, (_, s) => [`S${s}`, Array.from({ length: 7 }, (_, t) => `task ${s}.${t}`)]);
  await reloadWithStorage(page, { tabs: [legacyTab('tab_handoff', 'handoff', sections)], activeTabId: 'tab_handoff' });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 640, deviceScaleFactor: 1, mobile: false });

  for (const name of ['S1', 'S2', 'S3']) {
    for (const targetGap of [44, 23, 11]) {
      const result = await page.evaluate(`(async () => {
      const list = document.getElementById('taskList');
      const header = __t.section('${name}');
      const top = list.getBoundingClientRect().top;
      list.scrollTop = 0;
      list.scrollTop += header.getBoundingClientRect().top - top - ${targetGap};
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = header.getBoundingClientRect();
      const x = rect.left + 40;
      let exposed = null;
      for (let y = Math.ceil(top + 1); y < Math.floor(rect.top - 1); y += 2) {
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest('.task-item, .section-header')) { exposed = { y, className: hit.className }; break; }
      }
      return {
        gap: rect.top - top,
        coverHeight: parseFloat(getComputedStyle(document.querySelector('.toolbar'), '::after').height),
        headerHeight: rect.height,
        front: header.classList.contains('sticky-cover-front'),
        exposed,
        headerVisible: document.elementFromPoint(x, rect.top + 3)?.closest('.section-header') === header,
      };
    })()`);
      assert.ok(Math.abs(result.gap - targetGap) <= 1, JSON.stringify({ name, targetGap, ...result }));
      assert.ok(result.coverHeight >= result.headerHeight + 10, JSON.stringify({ name, targetGap, ...result }));
      assert.equal(result.front, true, JSON.stringify({ name, targetGap, ...result }));
      assert.equal(result.exposed, null, JSON.stringify({ name, targetGap, ...result }));
      assert.equal(result.headerVisible, true, JSON.stringify({ name, targetGap, ...result }));
    }
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
});
