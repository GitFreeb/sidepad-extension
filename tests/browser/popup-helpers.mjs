// Хелперы, которые выполняются внутри popup.html до загрузки его скриптов.
// HTML5 drag&drop и файловые диалоги нельзя «нажать» через CDP, поэтому тесты
// воспроизводят их теми же DOM-событиями, которые слушает popup.js.
export const PAGE_HELPERS = `
(() => {
  window.__dialogs = [];
  window.__confirmAnswer = true;
  window.confirm = (message) => { window.__dialogs.push({ type: 'confirm', message }); return window.__confirmAnswer; };
  window.alert = (message) => { window.__dialogs.push({ type: 'alert', message }); };
  window.__openedTabs = [];
  const $ = (selector) => {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) throw new Error('missing element ' + selector);
    return el;
  };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  window.__t = {
    $,
    click(selector) { $(selector).click(); },
    dblclick(selector) { $(selector).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); },
    type(selector, value, k = 'Enter') {
      const el = $(selector);
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (k) key(el, k);
    },
    key(selector, k) { key($(selector), k); },
    task(text) {
      return [...document.querySelectorAll('.task-item')].find((li) => li.querySelector('.task-text, .task-edit-input')?.textContent === text
        || li.querySelector('.task-edit-input')?.value === text);
    },
    section(name) {
      return [...document.querySelectorAll('.section-header')].find((li) => li.dataset.section === name);
    },
    tab(name) {
      return [...document.querySelectorAll('.tab')].find((el) => el.querySelector('.tab-name')?.textContent === name);
    },
    drag(source, target, where = 'before', axis = 'y') {
      const src = $(source);
      const tgt = $(target);
      const r = tgt.getBoundingClientRect();
      const point = axis === 'y'
        ? { clientX: r.left + r.width / 2, clientY: where === 'before' ? r.top + 2 : r.bottom - 2 }
        : { clientX: where === 'before' ? r.left + 2 : r.right - 2, clientY: r.top + r.height / 2 };
      const dataTransfer = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...point }));
      tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...point }));
      if (src.isConnected) src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    },
    model() {
      const out = [];
      let current = null;
      document.querySelectorAll('#taskList .section-header, #taskList .task-item').forEach((li) => {
        if (li.classList.contains('section-header')) {
          current = { name: li.dataset.section, collapsed: li.classList.contains('collapsed'), tasks: [] };
          out.push(current);
        } else if (li.classList.contains('task-item') && current) {
          const text = li.querySelector('.task-text')?.textContent ?? li.querySelector('.task-edit-input')?.value;
          current.tasks.push((li.classList.contains('done') ? '[x] ' : '[ ] ') + text);
        }
      });
      return out;
    },
    tabs() {
      return [...document.querySelectorAll('.tab')].map((el) => (el.classList.contains('active') ? '*' : '') + el.querySelector('.tab-name')?.textContent);
    },
    async storage(keys = null) { return chrome.storage.local.get(keys); },
  };
})();
`;

export function legacyTab(id, title, sections, extra = {}) {
  let nextId = 20001;
  const tasks = [];
  const names = [];
  for (const [name, items] of sections) {
    names.push(name);
    for (const item of items) {
      const done = item.startsWith('[x] ');
      const text = item.replace(/^\[[ x]\] /, '');
      tasks.push({ id: nextId++, section: name, text, url: '', done });
    }
  }
  return { id, title, tasks, sections: names, autoSave: false, ...extra };
}

// Свежий updateInfo не даёт popup.js ходить на GitHub за манифестом — тесты
// остаются офлайновыми и сетевой журнал содержит только то, что проверяется.
export function freshUpdateInfo(version = '0.0.0') {
  return { lastChecked: Date.now(), latestVersion: version, dismissedVersion: '' };
}

export async function openPopup(browser, seed = {}) {
  const page = await browser.open(browser.extensionUrl('popup.html'), { beforeLoad: PAGE_HELPERS });
  await reloadWithStorage(page, seed);
  return page;
}

export async function reloadWithStorage(page, seed) {
  await page.evaluate(`chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify({
    lang: 'ru',
    updateInfo: freshUpdateInfo(),
    ...seed,
  })}))`);
  await reload(page);
}

export async function reload(page) {
  const loaded = new Promise((resolve) => {
    const off = page.on('Page.loadEventFired', () => { off(); resolve(); });
  });
  await page.send('Page.reload');
  await loaded;
  await page.waitFor(`document.querySelectorAll('#tabStrip .tab').length > 0`);
}
