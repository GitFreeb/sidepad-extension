/* ── Default tasks ── */
const DEFAULT_TASKS = [];

/* ── i18n ── */
const I18N = {
  ru: {
    selectSectionPlaceholder: 'Выбор секции',
    autoSectionBase:          'Новая секция',
    emptyList:          'Нет задач. Добавьте первую!',
    loadExample:        'Загрузить пример →',
    emptySection:       'нет задач',
    clearConfirm:         'Список будет очищен. Текущая версия сохранится в Downloads.',
    closeNoSaveConfirm:   'Список будет закрыт без сохранения. Продолжить?',
    tabCloseTitle:        'Закрыть (сохранить в Downloads)',
    autoSaveLabel:        '↓auto',
    autoSaveOnTitle:      'Автосохранение включено',
    autoSaveOffTitle:     'Автосохранение выключено',
    moveToTitle:          'Переместить в секцию',
    renameSectionTitle:   'Переименовать секцию',
    deleteSectionTitle: 'Удалить секцию',
    copyTitle:          'Копировать',
    deleteTitle:        'Удалить',
    sectionPlaceholder: 'новая секция...',
    taskPlaceholder:    'новая задача...',
    urlPlaceholder:     'url (необязательно)',
    addBtn:             '+ добавить',
    importBtn:          '↑ загрузить',
    exportBtn:          '↓ выгрузить',
    clearBtn:           '✕ очистить',
    collapseBtn:        '▸ свернуть',
    expandBtn:          '▾ развернуть',
    themeTitle:         'Сменить тему',
    langTitle:          'Switch to English',
    langLabel:          'RU',
    updateAvailable:      'Доступна версия {version} → Обновить',
    updateBannerClose:    'Скрыть',
  },
  en: {
    selectSectionPlaceholder: 'Select section',
    autoSectionBase:          'New section',
    emptyList:          'No tasks. Add the first one!',
    loadExample:        'Load example →',
    emptySection:       'no tasks',
    clearConfirm:         'The list will be cleared. Current version will be saved to Downloads.',
    closeNoSaveConfirm:   'List will be closed without saving. Continue?',
    tabCloseTitle:        'Close (save to Downloads)',
    autoSaveLabel:        '↓auto',
    autoSaveOnTitle:      'Auto-save enabled',
    autoSaveOffTitle:     'Auto-save disabled',
    moveToTitle:          'Move to section',
    renameSectionTitle:   'Rename section',
    deleteSectionTitle: 'Delete section',
    copyTitle:          'Copy',
    deleteTitle:        'Delete',
    sectionPlaceholder: 'new section...',
    taskPlaceholder:    'new task...',
    urlPlaceholder:     'url (optional)',
    addBtn:             '+ add',
    importBtn:          '↑ import',
    exportBtn:          '↓ export',
    clearBtn:           '✕ clear',
    collapseBtn:        '▸ collapse',
    expandBtn:          '▾ expand',
    themeTitle:         'Switch theme',
    langTitle:          'Переключить на русский',
    langLabel:          'EN',
    updateAvailable:      'Version {version} is available → Update',
    updateBannerClose:    'Dismiss',
  },
};

let lang = 'en';
function tr(key) { return I18N[lang]?.[key] ?? key; }

const LEGACY_DEFAULT_SECTIONS = new Set(['__default__', 'Дополнительные задачи', 'Extra tasks']);

/* ── Update check ── */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MANIFEST_RAW_URL = 'https://raw.githubusercontent.com/GitFreeb/sidepad-extension/main/manifest.json';
const REPO_URL = 'https://github.com/GitFreeb/sidepad-extension';

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

let updateInfo = {
  lastChecked: 0,
  latestVersion: chrome.runtime.getManifest().version,
  dismissedVersion: '',
};

function checkForUpdate() {
  chrome.storage.local.get(['updateInfo'], (data) => {
    if (data.updateInfo) updateInfo = data.updateInfo;

    const stale = Date.now() - (updateInfo.lastChecked || 0) > UPDATE_CHECK_INTERVAL_MS;
    if (!stale) {
      renderUpdateBanner();
      return;
    }

    fetch(MANIFEST_RAW_URL)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad status'))))
      .then((json) => {
        const current = chrome.runtime.getManifest().version;
        const remote  = String(json && json.version || '');
        if (remote && compareVersions(remote, current) > 0) {
          updateInfo.latestVersion = remote;
        } else {
          updateInfo.latestVersion = current;
          updateInfo.dismissedVersion = '';
        }
      })
      .catch(() => {})
      .finally(() => {
        updateInfo.lastChecked = Date.now();
        chrome.storage.local.set({ updateInfo });
        renderUpdateBanner();
      });
  });
}

function renderUpdateBanner() {
  const current = chrome.runtime.getManifest().version;
  const hasUpdate = compareVersions(updateInfo.latestVersion, current) > 0;

  if (hasUpdate) {
    chrome.action.setBadgeText({ text: '•' });
    chrome.action.setBadgeBackgroundColor({ color: '#f0a93b' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }

  const banner = document.getElementById('updateBanner');
  const showBanner = hasUpdate && updateInfo.latestVersion !== updateInfo.dismissedVersion;
  banner.hidden = !showBanner;
  if (showBanner) {
    document.getElementById('updateBannerText').textContent =
      tr('updateAvailable').replace('{version}', updateInfo.latestVersion);
  }
}

function getNextSectionName(existingSections) {
  const base = tr('autoSectionBase');
  let n = 1;
  while (existingSections.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function applyLang(l, save = true) {
  lang = l;
  document.documentElement.lang = l;
  document.getElementById('sectionInput').placeholder    = tr('sectionPlaceholder');
  document.getElementById('taskInput').placeholder       = tr('taskPlaceholder');
  document.getElementById('linkInput').placeholder       = tr('urlPlaceholder');
  document.getElementById('addBtn').textContent          = tr('addBtn');
  document.getElementById('importBtn').textContent       = tr('importBtn');
  document.getElementById('exportBtn').textContent       = tr('exportBtn');
  document.getElementById('clearDoneBtn').textContent    = tr('clearBtn');
  document.getElementById('collapseAllBtn').textContent  = allCollapsed ? tr('expandBtn') : tr('collapseBtn');
  document.getElementById('themeBtn').title              = tr('themeTitle');
  applyAutoSave(autoSave, false);
  const lb = document.getElementById('langBtn');
  lb.textContent = tr('langLabel');
  lb.title       = tr('langTitle');
  if (save) {
    chrome.storage.local.set({ lang: l });
    render();
  }
}

/* ── State ── */
let tabs        = [];
let activeTabId = '';
let tasks       = [];
let sections    = [];
let collapsedSections = new Set();
let dragType  = null;
let dragId    = null;
let editingId = null;
let renamingTabId       = null;
let renamingSection     = null;
let moveMenuTaskId      = null;
let justExpandedSection = null;
let autoSave          = true;
let selectedSection = null;
let allCollapsed = false;

function applyAutoSave(on, save = true) {
  autoSave = on;
  const btn = document.getElementById('autoSaveBtn');
  if (btn) {
    btn.textContent = tr('autoSaveLabel');
    btn.title       = on ? tr('autoSaveOnTitle') : tr('autoSaveOffTitle');
    btn.classList.toggle('off', !on);
  }
  if (save) chrome.storage.local.set({ autoSave: on });
}

function updateCollapseBtn() {
  const btn = document.getElementById('collapseAllBtn');
  if (btn) btn.textContent = allCollapsed ? tr('expandBtn') : tr('collapseBtn');
}

/* ── Tab helpers ── */
function getActiveTab() {
  return tabs.find(t => t.id === activeTabId);
}

function saveAllTabs() {
  chrome.storage.local.set({ tabs, activeTabId });
}

function updateTabOverflow() {
  const strip     = document.getElementById('tabStrip');
  const badgeR    = document.getElementById('tabOverflow');
  const badgeL    = document.getElementById('tabOverflowLeft');
  const wrap      = strip?.parentElement;
  if (!strip || !badgeR || !badgeL || !wrap) return;

  const scrollLeft = strip.scrollLeft;
  const visibleEnd = scrollLeft + strip.clientWidth;

  let hiddenRight = 0, hiddenLeft = 0;
  strip.querySelectorAll('.tab').forEach(tab => {
    if (tab.offsetLeft >= visibleEnd - 2)                     hiddenRight++;
    if (tab.offsetLeft + tab.offsetWidth <= scrollLeft + 2)   hiddenLeft++;
  });

  badgeR.textContent = `+${hiddenRight}`;
  badgeR.classList.toggle('visible', hiddenRight > 0);
  wrap.classList.toggle('overflow-right', hiddenRight > 0);

  badgeL.textContent = `+${hiddenLeft}`;
  badgeL.classList.toggle('visible', hiddenLeft > 0);
  wrap.classList.toggle('overflow-left', hiddenLeft > 0);
}

function renderTabs() {
  const strip = document.getElementById('tabStrip');
  strip.innerHTML = tabs.map(tab => {
    const isActive = tab.id === activeTabId;
    const slug = tab.title.toLowerCase().replace(/\s+/g, '-');
    const display = slug.endsWith('.md') ? slug : slug + '.md';
    const nameHtml = tab.id === renamingTabId
      ? `<input class="tab-rename-input" data-rename-id="${escapeHtml(tab.id)}" value="${escapeHtml(tab.title)}" maxlength="60">`
      : `<span class="tab-name">${escapeHtml(display)}</span>`;
    return `<div class="tab${isActive ? ' active' : ''}" data-tab-id="${escapeHtml(tab.id)}">
      <span class="tab-icon">✳</span>
      ${nameHtml}
      <button class="tab-close" data-close-id="${escapeHtml(tab.id)}" title="${tr('tabCloseTitle')}">×</button>
    </div>`;
  }).join('');

  if (renamingTabId) {
    const inp = strip.querySelector('.tab-rename-input');
    if (inp) { inp.focus(); inp.select(); }
  }

  // scroll active tab into view after rebuild
  const activeEl = strip.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  updateTabOverflow();
}

function deriveSections(taskList) {
  return [...new Set(taskList.map(t => t.section).filter(Boolean))];
}

function switchTab(id) {
  if (id === activeTabId) return;
  const current = getActiveTab();
  if (current) { current.tasks = tasks; current.sections = sections; }
  activeTabId = id;
  const next = getActiveTab();
  if (!next) return;
  tasks    = next.tasks;
  sections = next.sections || deriveSections(next.tasks);
  applyTitle(next.title);
  resetCollapsedState();
  editingId = null;
  renamingSection = null;
  moveMenuTaskId = null;
  selectedSection = null;
  allCollapsed = false;
  updateCollapseBtn();
  saveAllTabs();
  renderTabs();
  render();
}

function closeTab(id) {
  const tabIdx = tabs.findIndex(t => t.id === id);
  if (tabIdx === -1) return;
  const tab = tabs[tabIdx];
  if (id === activeTabId) { tab.tasks = tasks; tab.sections = sections; }
  if (autoSave) {
    if (tab.tasks.length > 0 && tab.title !== 'example') autoSaveMdData(tab.tasks, tab.title);
  } else if (tab.tasks.length > 0 && tab.title !== 'default' && tab.title !== 'example') {
    if (!confirm(tr('closeNoSaveConfirm'))) return;
  }

  // Last tab: reset to default instead of removing
  if (tabs.length === 1) {
    const dt     = DEFAULT_TASKS.map(t => ({ ...t }));
    tab.title    = 'default';
    tab.tasks    = dt;
    tab.sections = deriveSections(dt);
    tasks        = dt;
    sections     = tab.sections;
    applyTitle('default');
    resetCollapsedState();
    editingId = null;
    renamingSection = null;
    moveMenuTaskId = null;
    selectedSection = null;
    allCollapsed = false;
    updateCollapseBtn();
    saveAllTabs();
    renderTabs();
    render();
    return;
  }

  tabs.splice(tabIdx, 1);
  if (renamingTabId === id) renamingTabId = null;
  if (activeTabId === id) {
    const newIdx = Math.min(tabIdx, tabs.length - 1);
    activeTabId  = tabs[newIdx].id;
    tasks        = tabs[newIdx].tasks;
    sections     = tabs[newIdx].sections || deriveSections(tabs[newIdx].tasks);
    applyTitle(tabs[newIdx].title);
    resetCollapsedState();
    editingId = null;
    renamingSection = null;
    moveMenuTaskId = null;
    selectedSection = null;
    allCollapsed = false;
    updateCollapseBtn();
    render();
  }
  saveAllTabs();
  renderTabs();
}

document.getElementById('tabStrip').addEventListener('click', (e) => {
  if (e.target.classList.contains('tab-rename-input')) return;
  const closeBtn = e.target.closest('[data-close-id]');
  if (closeBtn) {
    e.stopPropagation();
    closeTab(closeBtn.dataset.closeId);
    return;
  }
  const tabEl = e.target.closest('[data-tab-id]');
  if (tabEl) switchTab(tabEl.dataset.tabId);
});

document.getElementById('tabStrip').addEventListener('dblclick', (e) => {
  if (e.target.closest('[data-close-id]')) return;
  const tabEl = e.target.closest('[data-tab-id]');
  if (tabEl) { renamingTabId = tabEl.dataset.tabId; renderTabs(); }
});

function finishRename(input) {
  if (!renamingTabId) return;
  const id   = input.dataset.renameId;
  const raw  = input.value.trim().replace(/\.md$/i, '');
  const name = raw || 'default';
  renamingTabId = null;
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    tab.title = name;
    if (id === activeTabId) applyTitle(name);
    saveAllTabs();
  }
  renderTabs();
}

document.getElementById('tabStrip').addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('tab-rename-input')) return;
  if (e.key === 'Enter')  { e.preventDefault(); finishRename(e.target); }
  if (e.key === 'Escape') { renamingTabId = null; renderTabs(); }
});

document.getElementById('tabStrip').addEventListener('focusout', (e) => {
  if (e.target.classList.contains('tab-rename-input')) finishRename(e.target);
});

/* ── Storage ── */
function applyTitle(name) {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const display = slug.endsWith('.md') ? slug : slug + '.md';
  document.getElementById('bcFile').textContent = display;
}

function migrateDefaultSection(tab) {
  const hasLegacy = (tab.tasks || []).some(t => LEGACY_DEFAULT_SECTIONS.has(t.section)) ||
                    (tab.sections || []).some(s => LEGACY_DEFAULT_SECTIONS.has(s));
  if (!hasLegacy) return tab;
  const existing = (tab.sections || []).filter(s => !LEGACY_DEFAULT_SECTIONS.has(s));
  const newName  = getNextSectionName(existing);
  tab.tasks    = (tab.tasks || []).map(t => LEGACY_DEFAULT_SECTIONS.has(t.section) ? { ...t, section: newName } : t);
  tab.sections = [...new Set((tab.sections || []).map(s => LEGACY_DEFAULT_SECTIONS.has(s) ? newName : s))];
  return tab;
}

function loadAll() {
  chrome.storage.local.get(['tabs', 'activeTabId', 'tasks', 'lightMode', 'listTitle', 'lang', 'autoSave'], (data) => {
    applyTheme(!!data.lightMode);
    applyLang(data.lang || 'en', false);
    applyAutoSave(data.autoSave !== false, false);

    if (data.tabs && data.tabs.length > 0) {
      tabs = data.tabs.map(migrateDefaultSection);
      activeTabId = tabs.find(t => t.id === data.activeTabId) ? data.activeTabId : tabs[0].id;
    } else if (data.tasks && data.tasks.length > 0) {
      // migrate from old single-tab format
      const id = 'tab_default';
      tabs = [migrateDefaultSection({ id, title: data.listTitle || 'default', tasks: data.tasks, sections: deriveSections(data.tasks) })];
      activeTabId = id;
    } else {
      const dt = DEFAULT_TASKS.map(t => ({ ...t }));
      tabs = [{ id: 'tab_default', title: 'default', tasks: dt, sections: deriveSections(dt) }];
      activeTabId = 'tab_default';
    }

    const active = getActiveTab() || tabs[0];
    activeTabId = active.id;
    tasks    = active.tasks;
    sections = active.sections || deriveSections(active.tasks);
    applyTitle(active.title);
    resetCollapsedState();
    renderTabs();
    render();
    checkForUpdate();
  });
}

function saveTasks() {
  const tab = getActiveTab();
  if (tab) {
    tab.tasks    = tasks;
    tab.sections = sections;
    saveAllTabs();
  }
}

/* ── Theme ── */
function applyTheme(light) {
  document.body.dataset.theme = light ? 'light' : '';
  document.getElementById('themeBtn').textContent = light ? '●' : '◐';
}

document.getElementById('themeBtn').addEventListener('click', () => {
  const next = document.body.dataset.theme !== 'light';
  applyTheme(next);
  chrome.storage.local.set({ lightMode: next });
});

document.getElementById('langBtn').addEventListener('click', () => {
  applyLang(lang === 'ru' ? 'en' : 'ru');
});

document.getElementById('autoSaveBtn').addEventListener('click', () => {
  applyAutoSave(!autoSave);
});

/* ── Markdown parser ── */
const URL_RE = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

function parseMd(content, fileName) {
  const lines = content.split('\n');
  const baseSection = fileName.replace(/\.[^.]+$/, '');
  let id = Date.now() + 10001;
  const result = [];
  let section = baseSection;

  // Markdown: has '- ' or '* ' bullets
  const isMd = lines.some(l => /^\s*[-*]\s+\S/.test(l));

  if (isMd) {
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === '---') continue;
      if (/^[-*]\s/.test(t)) {
        let raw = t.slice(2).trim();
        let done = false;
        if (/^\[x\] /i.test(raw)) { done = true; raw = raw.slice(4); }
        else if (raw.startsWith('[ ] ')) { raw = raw.slice(4); }
        const matches = raw.match(URL_RE) || [];
        const url = matches[0] ? matches[0].replace(/[),>]+$/, '') : '';
        const text = raw.replace(URL_RE, '').replace(/\s{2,}/g, ' ').trim() || raw;
        result.push({ id: id++, section, text, url, done });
      } else if (!t.startsWith('|') && !t.startsWith('`') && !t.startsWith('!') && t.length < 240) {
        section = t.replace(/^#+\s*/, '').trim() || section;
      }
    }
    return result;
  }

  // Plain text parser: numbered lists, ALL CAPS headings, "heading:" style
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t === '---' || /^[=\-]{3,}$/.test(t)) continue;

    const nextT = (lines[i + 1] || '').trim();

    // Setext heading: next line is all dashes or equals
    if (/^[-=]{3,}$/.test(nextT)) {
      section = t || section;
      i++;
      continue;
    }

    // ALL CAPS heading (≥2 consecutive capitals, ≤60 chars, no URL)
    if (t === t.toUpperCase() && /[A-ZА-ЯЁ]{2,}/.test(t) && t.length <= 60 && !URL_RE.test(t)) {
      section = t;
      continue;
    }

    // Line ending with ':' (≤60 chars, no URL)
    if (t.endsWith(':') && t.length <= 60 && !URL_RE.test(t)) {
      section = t.slice(0, -1).trim() || section;
      continue;
    }

    if (t.startsWith('|') || t.startsWith('`') || t.startsWith('!') || t.length >= 240) continue;

    let raw = t;

    // Numbered list: "1. text" or "1) text"
    const numMatch = t.match(/^\d+[.)]\s+(.*)/);
    if (numMatch) raw = numMatch[1].trim();

    // Bullet with * or •
    if (!numMatch && /^[*•]\s+/.test(t)) raw = t.replace(/^[*•]\s+/, '');

    let done = false;
    if (/^\[x\] /i.test(raw) || /^[✓✔]\s/.test(raw)) { done = true; raw = raw.replace(/^(\[x\]\s+|[✓✔]\s+)/i, ''); }
    else if (raw.startsWith('[ ] ')) { raw = raw.slice(4); }

    const matches = raw.match(URL_RE) || [];
    const url = matches[0] ? matches[0].replace(/[),>]+$/, '') : '';
    const text = raw.replace(URL_RE, '').replace(/\s{2,}/g, ' ').trim();
    if (text) result.push({ id: id++, section, text, url, done });
  }

  return result;
}

/* ── File import ── */
let lastFileHandle = null;

document.getElementById('importBtn').addEventListener('click', async () => {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Markdown / Text', accept: { 'text/plain': ['.md', '.txt'] } }],
      multiple: false,
    });
    lastFileHandle = handle;
    const file = await handle.getFile();
    const imported = parseMd(await file.text(), file.name);
    if (!imported.length) return;

    const current = getActiveTab();
    if (current) { current.tasks = tasks; current.sections = sections; }

    const title = file.name.replace(/\.[^.]+$/, '');
    const newSections = deriveSections(imported);
    const newTab = { id: 'tab_' + Date.now(), title, tasks: imported, sections: newSections };
    tabs.push(newTab);
    activeTabId = newTab.id;
    tasks    = imported;
    sections = newSections;

    // Close the empty default tab if other tabs now exist
    const defaultIdx = tabs.findIndex(t => t.title === 'default' && t.id !== newTab.id);
    if (defaultIdx !== -1) tabs.splice(defaultIdx, 1);

    applyTitle(title);
    resetCollapsedState();
    editingId = null;
    saveAllTabs();
    renderTabs();
    render();
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
});

/* ── File export ── */
function generateMd(taskList, titleStr) {
  const tl = taskList || tasks;
  const title = titleStr || document.getElementById('bcFile').textContent || 'tasks';
  let md = `# ${title}\n\n`;
  const map = new Map();
  tl.forEach(item => {
    const key = item.section;
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  map.forEach((items, section) => {
    md += `## ${section}\n\n`;
    items.forEach(item => {
      md += `- [${item.done ? 'x' : ' '}] ${item.text}`;
      if (item.url) md += `  ${item.url}`;
      md += '\n';
    });
    md += '\n';
  });
  return md.trim();
}

document.getElementById('exportBtn').addEventListener('click', async () => {
  const filename = document.getElementById('bcFile').textContent || 'tasks.md';
  try {
    const opts = {
      suggestedName: filename,
      types: [{ description: 'Markdown', accept: { 'text/plain': ['.md'] } }],
    };
    if (lastFileHandle) opts.startIn = lastFileHandle;
    const handle = await window.showSaveFilePicker(opts);
    const writable = await handle.createWritable();
    await writable.write(generateMd());
    await writable.close();
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
});


/* ── Drag helpers ── */
function clearDragUI() {
  document.querySelectorAll('.drag-before, .drag-after, .drag-over-section')
    .forEach(el => el.classList.remove('drag-before', 'drag-after', 'drag-over-section'));
}

function moveTask(sourceId, targetId, pos) {
  const srcTask = tasks.find(t => t.id === sourceId);
  const tgtTask = tasks.find(t => t.id === targetId);
  if (!srcTask || !tgtTask) return;
  const arr = tasks.filter(t => t.id !== sourceId);
  const tgtIdx = arr.findIndex(t => t.id === targetId);
  arr.splice(pos === 'after' ? tgtIdx + 1 : tgtIdx, 0, { ...srcTask, section: tgtTask.section });
  tasks = arr;
  syncAutoCollapse(); saveTasks(); render();
}

function moveTaskToSection(sourceId, targetSection, pos = 'end') {
  const srcTask = tasks.find(t => t.id === sourceId);
  if (!srcTask) return;
  const arr = tasks.filter(t => t.id !== sourceId);
  let insertAt;
  if (pos === 'start') {
    const firstIdx = arr.findIndex(t => t.section === targetSection);
    insertAt = firstIdx === -1 ? arr.length : firstIdx;
  } else {
    insertAt = arr.length;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].section === targetSection) { insertAt = i + 1; break; }
    }
  }
  arr.splice(insertAt, 0, { ...srcTask, section: targetSection });
  tasks = arr;
  if (!srcTask.done) collapsedSections.delete(targetSection);
  syncAutoCollapse(); saveTasks(); render();
}

function moveSection(sourceName, targetName, pos) {
  const srcTasks = tasks.filter(t => t.section === sourceName);
  const rest     = tasks.filter(t => t.section !== sourceName);
  let first = -1, last = -1;
  rest.forEach((t, i) => { if (t.section === targetName) { if (first < 0) first = i; last = i; } });
  if (first < 0) return;
  rest.splice(pos === 'after' ? last + 1 : first, 0, ...srcTasks);
  tasks = rest;
  const newOrder = deriveSections(tasks);
  sections = [...newOrder, ...sections.filter(s => !newOrder.includes(s))];
  syncAutoCollapse(); saveTasks(); render();
}

/* ── Collapse state ── */
function resetCollapsedState() {
  collapsedSections.clear();
  const map = new Map();
  tasks.forEach(t => {
    const key = t.section;
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  map.forEach((items, title) => {
    if (items.length > 0 && items.every(t => t.done)) {
      collapsedSections.add(title);
    }
  });
}

function syncAutoCollapse() {
  const map = new Map();
  tasks.forEach(t => {
    if (!t.section) return;
    if (!map.has(t.section)) map.set(t.section, []);
    map.get(t.section).push(t);
  });
  map.forEach((items, title) => {
    if (items.length > 0 && items.every(t => t.done)) collapsedSections.add(title);
  });
}

/* ── Toast ── */
let toastTimer = null;
function showToast(anchorEl) {
  const toast = document.getElementById('toast');
  toast.classList.remove('visible');
  toast.textContent = '⧉  copied';

  const r = anchorEl.getBoundingClientRect();
  toast.style.left = r.left + 'px';
  toast.style.top  = (r.top - 6) + 'px';
  toast.style.transform = 'translateY(-100%)';

  void toast.offsetWidth;
  toast.classList.add('visible');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    toastTimer = null;
  }, 2000);
}

/* ── Load example ── */
async function loadExample() {
  try {
    const res  = await fetch('./example.md');
    const text = await res.text();
    const imported = parseMd(text, 'example.md');
    if (!imported.length) return;

    const current = getActiveTab();
    if (current) { current.tasks = tasks; current.sections = sections; }

    const newTab = { id: 'tab_' + Date.now(), title: 'example', tasks: imported, sections: deriveSections(imported) };
    tabs.push(newTab);
    activeTabId = newTab.id;
    tasks    = imported;
    sections = newTab.sections;

    const defaultIdx = tabs.findIndex(t => t.title === 'default' && t.id !== newTab.id);
    if (defaultIdx !== -1) tabs.splice(defaultIdx, 1);

    applyTitle('example');
    resetCollapsedState();
    editingId = null;
    saveAllTabs();
    renderTabs();
    render();
  } catch (e) {
    console.error(e);
  }
}

/* ── Edit helpers ── */
function saveEdit(input) {
  if (editingId === null) return;
  const text = input.value.trim();
  const id   = editingId;
  editingId  = null;
  if (text) {
    tasks = tasks.map(t => t.id === id ? { ...t, text } : t);
    saveTasks();
  }
  render();
}

/* ── Render ── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render() {
  const list    = document.getElementById('taskList');
  const counter = document.getElementById('counter');

  const doneCount = tasks.filter(t => t.done).length;
  counter.textContent = `${doneCount} / ${tasks.length}`;

  if (!tasks.length && !sections.length) {
    justExpandedSection = null;
    updateSectionSelect();
    const isDefault = getActiveTab()?.title === 'default';
    list.innerHTML = `<div class="empty-msg">
      ${tr('emptyList')}
      ${isDefault ? `<button class="btn-load-example" id="loadExampleBtn">${tr('loadExample')}</button>` : ''}
    </div>`;
    if (isDefault) {
      document.getElementById('loadExampleBtn')?.addEventListener('click', loadExample);
    }
    return;
  }

  const taskMap = new Map();
  tasks.forEach(t => {
    const key = t.section;
    if (!key) return;
    if (!taskMap.has(key)) taskMap.set(key, []);
    taskMap.get(key).push(t);
  });

  // ordered: user-defined sections first, then any from tasks not yet in list
  const orderedSections = [...sections];
  taskMap.forEach((_, key) => { if (!orderedSections.includes(key)) orderedSections.push(key); });

  let html = '';
  orderedSections.forEach(title => {
    const items = taskMap.get(title) || [];
    const secDone = items.filter(t => t.done).length;
    const isCollapsed = collapsedSections.has(title);
    const isRenaming  = renamingSection === title;

    html += `<li class="section-header${isCollapsed ? ' collapsed' : ''}" data-section="${escapeHtml(title)}" data-action="toggle-section" draggable="${isRenaming ? 'false' : 'true'}">
      ${isRenaming
        ? `<input class="section-rename-input" data-rename-section="${escapeHtml(title)}" value="${escapeHtml(title)}" maxlength="80" draggable="false">`
        : `<span class="section-title">${escapeHtml(title)}</span>`}
      <div class="section-right">
        ${!isRenaming && items.length > 0 ? `<span class="section-count">${secDone}/${items.length}</span>` : ''}
        ${!isRenaming ? `<span class="section-caret">›</span>` : ''}
        ${!isRenaming ? `<button class="btn-rename-section" data-action="rename-section" data-section="${escapeHtml(title)}" title="${tr('renameSectionTitle')}" draggable="false">✎</button>` : ''}
        <button class="btn-delete-section" data-action="delete-section" data-section="${escapeHtml(title)}" title="${tr('deleteSectionTitle')}" draggable="false">×</button>
      </div>
    </li>`;

    if (!isCollapsed) {
      if (items.length === 0) {
        html += `<li class="section-empty">${tr('emptySection')}</li>`;
      }
      items.forEach(task => {
        const isEditing    = task.id === editingId;
        const isMoveOpen   = task.id === moveMenuTaskId;
        const otherSecs    = orderedSections.filter(s => s !== task.section);
        const moveMenuHtml = isMoveOpen && otherSecs.length > 0
          ? `<ul class="move-section-menu" data-move-id="${task.id}">
              ${otherSecs.map(s => `<li data-action="move-to-section" data-section="${escapeHtml(s)}">${escapeHtml(s)}</li>`).join('')}
            </ul>`
          : '';
        html += `<li class="task-item ${task.done ? 'done' : ''}${isEditing ? ' editing' : ''}${isMoveOpen ? ' move-open' : ''}" data-id="${task.id}" draggable="${isEditing ? 'false' : 'true'}">
          <span class="drag-handle" draggable="false">⠿</span>
          <input type="checkbox" class="task-checkbox" data-action="toggle" ${task.done ? 'checked' : ''} draggable="false">
          <div class="task-content">
            ${isEditing
              ? `<input type="text" class="task-edit-input" data-action="edit-input" value="${escapeHtml(task.text)}" maxlength="240" draggable="false">`
              : `<div class="task-text" data-action="edit-text">${escapeHtml(task.text)}</div>`}
            ${task.url
              ? `<a class="task-link" href="${escapeHtml(task.url)}" data-action="link" title="${escapeHtml(task.url)}" draggable="false">${escapeHtml(task.url)}</a>`
              : ''}
          </div>
          <button class="btn-copy" data-action="copy" title="${tr('copyTitle')}" draggable="false">⧉</button>
          ${otherSecs.length > 0
            ? `<button class="btn-move" data-action="move-task" title="${tr('moveToTitle')}" draggable="false">→</button>`
            : ''}
          ${task.id > 10000
            ? `<button class="btn-delete" data-action="delete" title="${tr('deleteTitle')}" draggable="false">×</button>`
            : ''}
          ${moveMenuHtml}
        </li>`;
      });
    }
  });

  list.innerHTML = html;
  updateSectionSelect();

  if (moveMenuTaskId !== null) {
    const menuEl = list.querySelector('.move-section-menu');
    const btnEl  = list.querySelector(`[data-id="${moveMenuTaskId}"] [data-action="move-task"]`);
    if (menuEl && btnEl) {
      const r = btnEl.getBoundingClientRect();
      menuEl.style.top   = (r.bottom + 4) + 'px';
      menuEl.style.right = (window.innerWidth - r.right) + 'px';
    }
  }

  if (editingId !== null) {
    const inp = list.querySelector('[data-action="edit-input"]');
    if (inp) { inp.focus(); inp.select(); }
  }
  if (renamingSection !== null) {
    const inp = list.querySelector('.section-rename-input');
    if (inp) { inp.focus(); inp.select(); }
  }

  if (justExpandedSection !== null) {
    const sec = justExpandedSection;
    justExpandedSection = null;
    for (const h of list.querySelectorAll('.section-header')) {
      if (h.dataset.section === sec) {
        h.scrollIntoView({ block: 'start', behavior: 'smooth' });
        break;
      }
    }
  }
}

/* ── Section rename ── */
function finishSectionRename(input) {
  const oldName = input.dataset.renameSection;
  const newName = input.value.trim();
  renamingSection = null;
  if (!newName || newName === oldName) { render(); return; }
  sections = [...new Set(sections.map(s => s === oldName ? newName : s))];
  tasks    = tasks.map(t => t.section === oldName ? { ...t, section: newName } : t);
  if (collapsedSections.has(oldName)) {
    collapsedSections.delete(oldName);
    collapsedSections.add(newName);
  }
  saveTasks();
  render();
}

/* ── List interactions ── */
function deleteSection(name) {
  collapsedSections.delete(name);
  sections = sections.filter(s => s !== name);
  tasks    = tasks.filter(t => t.section !== name);
  saveTasks();
  render();
}

document.getElementById('taskList').addEventListener('click', (e) => {
  const delSecBtn = e.target.closest('[data-action="delete-section"]');
  if (delSecBtn) {
    e.stopPropagation();
    deleteSection(delSecBtn.dataset.section);
    return;
  }

  const renameSecBtn = e.target.closest('[data-action="rename-section"]');
  if (renameSecBtn) {
    e.stopPropagation();
    renamingSection = renameSecBtn.dataset.section;
    render();
    return;
  }

  const sectionEl = e.target.closest('[data-action="toggle-section"]');
  if (sectionEl) {
    if (e.target.closest('.section-rename-input')) return;
    const title = sectionEl.dataset.section;
    if (collapsedSections.has(title)) {
      collapsedSections.delete(title);
      justExpandedSection = title;
    } else {
      collapsedSections.add(title);
    }
    render();
    return;
  }

  const item   = e.target.closest('[data-id]');
  if (!item) return;
  const id     = Number(item.dataset.id);
  const action = e.target.closest('[data-action]')?.dataset.action;

  if (action === 'move-task') {
    e.stopPropagation();
    moveMenuTaskId = (moveMenuTaskId === id) ? null : id;
    render();
    return;
  }
  if (action === 'move-to-section') {
    e.stopPropagation();
    const li       = e.target.closest('[data-action="move-to-section"]');
    const taskId   = Number(li.closest('.move-section-menu').dataset.moveId);
    const target   = li.dataset.section;
    moveMenuTaskId = null;
    moveTaskToSection(taskId, target, 'start');
    return;
  }

  if (action === 'edit-text') {
    editingId = id;
    render();
    return;
  }
  if (action === 'copy') {
    const task = tasks.find(t => t.id === id);
    if (task) {
      navigator.clipboard.writeText(task.text).catch(() => {});
      showToast(item);
      const btn = e.target.closest('[data-action="copy"]');
      if (btn) {
        btn.classList.add('copy-flash');
        setTimeout(() => btn.classList.remove('copy-flash'), 700);
      }
    }
    return;
  }
  if (action === 'toggle') {
    const wasUndone = !tasks.find(t => t.id === id).done;
    tasks = tasks.map(t => t.id === id ? { ...t, done: !t.done } : t);
    if (wasUndone) {
      const toggled = tasks.find(t => t.id === id);
      const sec = toggled.section;
      const rest = tasks.filter(t => t.id !== id);
      let lastIdx = -1;
      rest.forEach((t, i) => { if (t.section === sec) lastIdx = i; });
      if (lastIdx !== -1) {
        rest.splice(lastIdx + 1, 0, toggled);
        tasks = rest;
      }
    }
    syncAutoCollapse();
    saveTasks();
    render();
  }
  if (action === 'delete') {
    tasks = tasks.filter(t => t.id !== id);
    syncAutoCollapse();
    saveTasks();
    render();
  }
  if (action === 'link') {
    e.preventDefault();
    chrome.tabs.create({ url: e.target.closest('[data-action="link"]').href });
  }
});

document.getElementById('taskList').addEventListener('keydown', (e) => {
  if (e.target.classList.contains('section-rename-input')) {
    if (e.key === 'Enter')  { e.preventDefault(); finishSectionRename(e.target); }
    if (e.key === 'Escape') { renamingSection = null; render(); }
    return;
  }
  if (e.target.dataset.action !== 'edit-input') return;
  if (e.key === 'Enter') { e.preventDefault(); saveEdit(e.target); }
  else if (e.key === 'Escape') { editingId = null; render(); }
});

document.getElementById('taskList').addEventListener('focusout', (e) => {
  if (e.target.classList.contains('section-rename-input') && renamingSection !== null) {
    finishSectionRename(e.target);
    return;
  }
  if (e.target.dataset.action === 'edit-input' && editingId !== null) {
    saveEdit(e.target);
  }
});

/* ── Custom section select ── */
function setSection(s) {
  selectedSection = s;
  const valEl = document.getElementById('sectionSelectVal');
  if (valEl) valEl.textContent = s === null ? tr('selectSectionPlaceholder') : s;
  document.querySelectorAll('#sectionSelectList .csel-item').forEach(li => {
    li.classList.toggle('active', li.dataset.value === s);
    li.classList.remove('focused');
  });
}

function openCsel() {
  const csel = document.getElementById('sectionSelect');
  if (!csel) return;
  csel.classList.add('open');
  const active = csel.querySelector('.csel-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function closeCsel() {
  const csel = document.getElementById('sectionSelect');
  if (csel) csel.classList.remove('open');
}

function updateSectionSelect() {
  const list = document.getElementById('sectionSelectList');
  if (!list) return;
  const fromTasks = [...new Set(tasks.map(t => t.section).filter(Boolean))];
  const allSections = [...new Set([...sections, ...fromTasks])];
  if (selectedSection !== null && !allSections.includes(selectedSection)) selectedSection = null;
  list.innerHTML = '';
  allSections.forEach(s => {
    const li = document.createElement('li');
    li.className = 'csel-item' + (s === selectedSection ? ' active' : '');
    li.textContent = s;
    li.dataset.value = s;
    li.addEventListener('mousedown', (e) => { e.preventDefault(); setSection(s); closeCsel(); });
    list.appendChild(li);
  });
  const valEl = document.getElementById('sectionSelectVal');
  if (valEl) valEl.textContent = selectedSection === null ? tr('selectSectionPlaceholder') : selectedSection;
}

/* ── Add section ── */
function addSection() {
  const input = document.getElementById('sectionInput');
  const name  = input.value.trim();
  if (!name) return;
  if (!sections.includes(name)) {
    sections.unshift(name);
    saveTasks();
    render();
  }
  input.value = '';
}

document.getElementById('sectionInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addSection();
});

/* ── Add task ── */
function addTask() {
  const textEl = document.getElementById('taskInput');
  const linkEl = document.getElementById('linkInput');
  const text   = textEl.value.trim();
  if (!text) return;

  let section = selectedSection;
  if (!section) {
    const namedSection = document.getElementById('sectionInput').value.trim();
    if (namedSection) {
      section = namedSection;
      document.getElementById('sectionInput').value = '';
    } else {
      section = getNextSectionName(sections);
    }
    if (!sections.includes(section)) sections.unshift(section);
  } else if (!sections.includes(section)) {
    sections.push(section);
  }
  const newTask = { id: Date.now() + 10001, section, text, url: linkEl.value.trim(), done: false };
  const firstIdx = tasks.findIndex(t => t.section === section);
  if (firstIdx === -1) tasks.push(newTask);
  else tasks.splice(firstIdx, 0, newTask);

  textEl.value = '';
  linkEl.value = '';
  setSection(null);
  textEl.focus();
  syncAutoCollapse();
  saveTasks();
  render();
}

document.getElementById('addBtn').addEventListener('click', () => {
  const sectionFilled = document.getElementById('sectionInput').value.trim();
  const taskFilled    = document.getElementById('taskInput').value.trim();
  if (taskFilled) addTask();
  else if (sectionFilled) addSection();
});
document.getElementById('taskInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addTask();
});
document.getElementById('linkInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addTask();
});
document.getElementById('sectionSelect').addEventListener('click', () => {
  const csel = document.getElementById('sectionSelect');
  csel.classList.contains('open') ? closeCsel() : openCsel();
});

document.getElementById('sectionSelect').addEventListener('keydown', e => {
  const csel  = document.getElementById('sectionSelect');
  const items = [...csel.querySelectorAll('.csel-item')];
  const isOpen = csel.classList.contains('open');

  if (e.key === 'Enter') {
    e.preventDefault();
    if (isOpen) {
      const focused = csel.querySelector('.csel-item.focused');
      if (focused) setSection(focused.dataset.value);
      closeCsel();
    } else {
      addTask();
    }
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (isOpen) {
      const focused = csel.querySelector('.csel-item.focused');
      if (focused) { setSection(focused.dataset.value); closeCsel(); }
    } else {
      openCsel();
    }
    return;
  }
  if (e.key === 'Escape') { closeCsel(); return; }
  if (e.key === 'Tab') { closeCsel(); return; }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!isOpen) { openCsel(); return; }
    const focused = csel.querySelector('.csel-item.focused');
    let idx = focused
      ? items.indexOf(focused)
      : items.findIndex(li => li.classList.contains('active'));
    if (idx === -1) idx = e.key === 'ArrowDown' ? -1 : 0;
    items.forEach(li => li.classList.remove('focused'));
    idx = e.key === 'ArrowDown'
      ? (idx + 1) % items.length
      : (idx - 1 + items.length) % items.length;
    items[idx].classList.add('focused');
    items[idx].scrollIntoView({ block: 'nearest' });
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#sectionSelect')) closeCsel();
  if (moveMenuTaskId !== null && !e.target.closest('.move-section-menu')) {
    moveMenuTaskId = null;
    render();
  }
});

/* Клик за пределами side panel не порождает события в её document —
   закрываем открытые меню по потере фокуса окном. */
window.addEventListener('blur', () => {
  closeCsel();
  if (moveMenuTaskId !== null) {
    moveMenuTaskId = null;
    render();
  }
});

/* ── Drag events ── */
(function () {
  const list = document.getElementById('taskList');

  list.addEventListener('dragstart', (e) => {
    const taskEl = e.target.closest('.task-item');
    const secEl  = e.target.closest('.section-header');
    if (taskEl) {
      dragType = 'task';
      dragId   = Number(taskEl.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => taskEl.classList.add('dragging'), 0);
    } else if (secEl) {
      dragType = 'section';
      dragId   = secEl.dataset.section;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => secEl.classList.add('dragging'), 0);
    } else {
      e.preventDefault();
    }
  });

  list.addEventListener('dragover', (e) => {
    if (!dragType) return;
    e.preventDefault();
    clearDragUI();
    const taskEl = e.target.closest('.task-item');
    const secEl  = e.target.closest('.section-header');
    if (dragType === 'task') {
      if (taskEl && Number(taskEl.dataset.id) !== dragId) {
        const r = taskEl.getBoundingClientRect();
        taskEl.classList.add(e.clientY < r.top + r.height / 2 ? 'drag-before' : 'drag-after');
      } else if (secEl) {
        secEl.classList.add('drag-over-section');
      }
    } else if (dragType === 'section') {
      if (secEl && secEl.dataset.section !== dragId) {
        const r = secEl.getBoundingClientRect();
        secEl.classList.add(e.clientY < r.top + r.height / 2 ? 'drag-before' : 'drag-after');
      }
    }
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDragUI();
    const taskEl = e.target.closest('.task-item');
    const secEl  = e.target.closest('.section-header');
    if (dragType === 'task') {
      if (taskEl && Number(taskEl.dataset.id) !== dragId) {
        const r = taskEl.getBoundingClientRect();
        moveTask(dragId, Number(taskEl.dataset.id), e.clientY < r.top + r.height / 2 ? 'before' : 'after');
      } else if (secEl) {
        moveTaskToSection(dragId, secEl.dataset.section);
      }
    } else if (dragType === 'section') {
      if (secEl && secEl.dataset.section !== dragId) {
        const r = secEl.getBoundingClientRect();
        moveSection(dragId, secEl.dataset.section, e.clientY < r.top + r.height / 2 ? 'before' : 'after');
      }
    }
    dragType = null; dragId = null;
  });

  list.addEventListener('dragend', () => {
    clearDragUI();
    document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    dragType = null; dragId = null;
  });
})();

/* ── Clear ── */
function switchToOrCreateDefault() {
  let defaultTab = tabs.find(t => t.title === 'default');
  if (!defaultTab) {
    const dt = DEFAULT_TASKS.map(t => ({ ...t }));
    defaultTab = { id: 'tab_' + Date.now(), title: 'default', tasks: dt, sections: deriveSections(dt) };
    tabs.push(defaultTab);
  }
  activeTabId = defaultTab.id;
  tasks    = defaultTab.tasks;
  sections = defaultTab.sections || deriveSections(defaultTab.tasks);
  applyTitle('default');
  resetCollapsedState();
  editingId = null; renamingSection = null; moveMenuTaskId = null;
  selectedSection = null; allCollapsed = false; updateCollapseBtn();
  saveAllTabs(); renderTabs(); render();
}

function autoSaveMdData(taskList, titleStr) {
  const title = (titleStr || 'tasks')
    .replace(/\.md$/, '')
    .replace(/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/, '');
  const now   = new Date();
  const stamp = now.getFullYear()
    + '-' + String(now.getMonth() + 1).padStart(2, '0')
    + '-' + String(now.getDate()).padStart(2, '0')
    + '_' + String(now.getHours()).padStart(2, '0')
    + '-' + String(now.getMinutes()).padStart(2, '0');
  const blob = new Blob([generateMd(taskList, title)], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `${title}_${stamp}.md` });
  a.click();
  URL.revokeObjectURL(url);
}

function autoSaveMd() {
  const title = document.getElementById('bcFile').textContent || 'tasks';
  autoSaveMdData(tasks, title);
}

document.getElementById('clearDoneBtn').addEventListener('click', () => {
  const activeTitle = getActiveTab()?.title;

  if (activeTitle === 'default') {
    if (autoSave && tasks.length > 0) autoSaveMd();
    tasks = []; sections = [];
    saveTasks(); render();
    return;
  }

  if (activeTitle !== 'example') {
    if (autoSave) {
      if (tasks.length > 0 && !confirm(tr('clearConfirm'))) return;
      if (tasks.length > 0) autoSaveMd();
    } else {
      if (tasks.length > 0 && !confirm(tr('closeNoSaveConfirm'))) return;
    }
  }

  tabs = tabs.filter(t => t.id !== activeTabId);
  switchToOrCreateDefault();
});

document.getElementById('collapseAllBtn').addEventListener('click', () => {
  if (!allCollapsed) {
    sections.forEach(s => collapsedSections.add(s));
    allCollapsed = true;
  } else {
    resetCollapsedState();
    allCollapsed = false;
  }
  updateCollapseBtn();
  render();
});

/* ── Tab overflow indicator ── */
(function () {
  const strip  = document.getElementById('tabStrip');
  const badgeR = document.getElementById('tabOverflow');
  const badgeL = document.getElementById('tabOverflowLeft');

  strip.addEventListener('scroll', updateTabOverflow, { passive: true });

  badgeR.addEventListener('click', () => {
    strip.scrollBy({ left: strip.clientWidth * 0.7, behavior: 'smooth' });
  });
  badgeL.addEventListener('click', () => {
    strip.scrollTo({ left: 0, behavior: 'smooth' });
  });

  new ResizeObserver(updateTabOverflow).observe(strip);
})();

/* ── Init ── */
loadAll();
