// Контроллер Notes API для единого интерфейса Sidepad. Собственного UI здесь
// нет: вкладка notes.md рисуется тем же popup.js, а этот модуль переводит её
// действия в semantic operations, применяет ответы сервера, опрашивает
// документ и ведёт подключение. Строки берутся из tr() в popup.js.
import { createFetchTransport, RevisionedNotesClient } from './notes-api-client.js';
import { NotesApiMode } from './notes-api-mode.js';
import { API_CREDENTIAL_STORAGE_KEY, NOTES_ORIGIN, NotesApiAuth } from './notes-api-auth.js';
import { SERVER_TAB_ID, SERVER_TAB_TITLE, StaleIntentError, captureIntent, documentToTab, planOperation } from './notes-api-tab.js';
import { VisiblePoller } from './notes-api-sync.js';
import {
  CONNECT_PENDING_STORAGE_KEY,
  activeConnectAttempt,
  beginConnectAttempt,
  cancelConnectAttempt,
  connectUrl,
} from './notes-api-connect.js';

const ORIGIN_PERMISSION = { origins: [`${NOTES_ORIGIN}/*`] };
const LEGACY_CHOICE_KEY = 'notesApiLegacyTabV1';
const SERVER_TAB_CLOSED_KEY = 'notesApiTabClosedV1';
const SERVER_TAB = { id: SERVER_TAB_ID, title: SERVER_TAB_TITLE, storage: 'notes-api', autoSave: false };

function chromeCall(fn) {
  return new Promise((resolve, reject) => {
    fn((value) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(value);
    });
  });
}

const localStore = {
  get: (keys) => chromeCall((done) => chrome.storage.local.get(keys, done)),
  set: (value) => chromeCall((done) => chrome.storage.local.set(value, done)),
  remove: (keys) => chromeCall((done) => chrome.storage.local.remove(keys, done)),
};

const permissions = {
  contains: (permission) => chromeCall((done) => chrome.permissions.contains(permission, done)).then(Boolean),
  request: (permission) => chromeCall((done) => chrome.permissions.request(permission, done)).then(Boolean),
  remove: (permission) => chromeCall((done) => chrome.permissions.remove(permission, done)).then(Boolean),
};

const auth = new NotesApiAuth({ storage: localStore });
const mode = new NotesApiMode({
  storage: localStore,
  permissions,
  originPermission: ORIGIN_PERMISSION,
  auth,
  clientFactory: () => new RevisionedNotesClient({
    transport: createFetchTransport({
      baseUrl: NOTES_ORIGIN,
      authorize: (init, context) => auth.authorizeContentRequest(init, context),
    }),
  }),
});

const $ = (id) => document.getElementById(id);
const el = {
  toggle: $('apiModeToggle'),
  hint: $('apiModeHint'),
  openTab: $('openServerTabBtn'),
  settingsBtn: $('apiSettingsBtn'),
  settings: $('apiSettings'),
  connLabel: $('apiConnLabel'),
  connState: $('apiConnState'),
  connect: $('apiConnectBtn'),
  forget: $('apiForgetBtn'),
  forgetHint: $('apiForgetHint'),
  legacyLabel: $('apiLegacyLabel'),
  legacyPrompt: $('apiLegacyPrompt'),
  legacySelect: $('apiLegacySelect'),
  legacySave: $('apiLegacySaveBtn'),
  recoverySummary: $('apiRecoverySummary'),
  recoveryHint: $('apiRecoveryHint'),
  pairingForm: $('apiPairingForm'),
  pairingIdLabel: $('apiPairingIdLabel'),
  pairingCodeLabel: $('apiPairingCodeLabel'),
  pairingLabelLabel: $('apiPairingLabelLabel'),
  pairingId: $('apiPairingIdInput'),
  pairingCode: $('apiPairingCodeInput'),
  pairingLabel: $('apiPairingLabelInput'),
  pair: $('apiPairBtn'),
  sync: $('syncState'),
  notice: $('serverNotice'),
  noticeText: $('serverNoticeText'),
  noticeActions: $('serverNoticeActions'),
};

const ui = {
  legacyChoice: undefined,
  tabClosed: false,
  pending: false,
  notice: null,
  appliedRevision: null,
  deferredApply: false,
  queue: [],
  pumping: false,
};

/* ── Backend registered in popup.js ── */

function authPhase() {
  return auth.snapshot().phase;
}

const backend = {
  legacyTabId: null,
  canWrite() {
    return authPhase() === 'current' && (mode.state.phase === 'current' || mode.state.phase === 'saving');
  },
  dispatch(intent) {
    const document = mode.state.confirmed?.document;
    if (!document || !backend.canWrite()) return;
    let captured;
    try {
      captured = captureIntent(document, intent);
    } catch (error) {
      if (!(error instanceof StaleIntentError)) throw error;
      notify('noticeStale');
      return;
    }
    ui.queue.push(captured);
    pump().catch(showLocalError);
  },
  notify,
  renderChrome,
  onServerTabClosed() {
    ui.tabClosed = true;
    localStore.set({ [SERVER_TAB_CLOSED_KEY]: true }).catch(() => {});
    renderModebar();
  },
  onLegacyTabClosed() {
    setLegacyChoice(null);
  },
};

const NOTICE_MS = 6000;
let noticeTimer = null;

function notify(key) {
  ui.notice = key;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { ui.notice = null; renderChrome(); }, NOTICE_MS);
  renderChrome();
}

/* ── Mutations: one semantic operation at a time ── */

async function pump() {
  if (ui.pumping) return;
  ui.pumping = true;
  try {
    while (ui.queue.length) {
      if (!(authPhase() === 'current' && mode.state.phase === 'current')) {
        ui.queue = [];
        break;
      }
      const intent = ui.queue.shift();
      let operation;
      try {
        // Refs действуют только в своей ревизии: разрешаем намерение против
        // последнего подтверждённого документа, а не того, что был при клике.
        operation = planOperation(mode.state.confirmed.document, intent);
      } catch (error) {
        if (!(error instanceof StaleIntentError)) throw error;
        ui.queue = [];
        notify('noticeStale');
        await mode.refresh({ quiet: true });
        break;
      }
      if (!operation) continue;
      await mode.submit(operation);
      if (mode.state.phase === 'conflict' && mode.state.conflictReason !== 'ambiguous') {
        ui.queue = [];
        notify(mode.state.conflictReason === 'rejected' ? 'noticeRejected' : 'noticeConflict');
        // Конфликт: перечитать документ без повтора операции.
        await mode.refresh({ quiet: true });
        break;
      }
      if (mode.state.phase !== 'current') {
        ui.queue = [];
        break;
      }
    }
  } finally {
    ui.pumping = false;
    renderChrome();
  }
}

/* ── Snapshot → popup.js ── */

function applySnapshot({ force = false } = {}) {
  const snapshot = mode.state.confirmed;
  if (!mode.enabled || !snapshot?.document) return;
  if (!force && snapshot.revision === ui.appliedRevision) return;
  if (sidepadServerBusy()) {
    ui.deferredApply = true;
    return;
  }
  const remote = ui.appliedRevision !== null && !ui.pumping;
  ui.appliedRevision = snapshot.revision;
  ui.deferredApply = false;
  sidepadApplyServerTab(documentToTab(snapshot.document), { remote });
}

let lastWritable = null;

function onModeChange() {
  if (mode.enabled) applySnapshot();
  const writable = backend.canWrite();
  if (writable !== lastWritable) {
    lastWritable = writable;
    // Read-only меняет сам список (чекбоксы, drag, кнопки), а не только индикатор.
    if (typeof sidepadRender === 'function' && sidepadServerTabId()) sidepadRender();
  }
  renderChrome();
}

/* ── Polling ── */

const poller = new VisiblePoller({
  isVisible: () => document.visibilityState === 'visible',
  async tick() {
    if (ui.deferredApply) applySnapshot();
    if (!mode.enabled || authPhase() !== 'current' || ui.pumping || sidepadServerBusy()) return 'ok';
    await mode.refresh({ quiet: true });
    return mode.state.phase === 'offline-read-only' ? 'backoff' : 'ok';
  },
});

document.addEventListener('visibilitychange', () => poller.wake());
window.addEventListener('focus', () => poller.wake());

/* ── Chrome: indicator, notice, modebar, settings ── */

function syncKind() {
  if (ui.pending && authPhase() !== 'current') return 'Pending';
  if (authPhase() !== 'current') return 'Auth';
  const { phase, conflictReason } = mode.state;
  if (phase === 'saving' || ui.pumping) return 'Saving';
  if (phase === 'offline-read-only') return 'Offline';
  if (phase === 'conflict') return conflictReason === 'ambiguous' ? 'Retry' : 'Conflict';
  if (phase === 'loading') return 'Loading';
  return 'Current';
}

function noticeFor(tabIsServer) {
  const actions = [];
  if (!tabIsServer) {
    if (!isLegacyLockedTab()) return null;
    actions.push(['actionGoServer', () => sidepadSwitchTab(sidepadServerTabId() || openServerTab())]);
    actions.push(['actionCloseTab', () => sidepadCloseTab(backend.legacyTabId)]);
    return { key: 'noticeLegacy', actions };
  }
  const kind = syncKind();
  if (kind === 'Pending') return { key: 'noticePending', actions: [['actionConnect', () => startConnect()]] };
  if (kind === 'Auth') {
    const key = auth.snapshot().errorReason === 'credential-rejected' ? 'noticeRejectedAuth' : 'noticeAuth';
    return { key, actions: [['actionConnect', () => startConnect()]] };
  }
  if (kind === 'Retry') return { key: 'noticeAmbiguous', actions: [['actionRetry', () => retryAmbiguous()]] };
  if (kind === 'Offline') return { key: 'noticeOffline', actions: [] };
  if (ui.notice) return { key: ui.notice, actions: [] };
  return null;
}

function renderNotice() {
  const notice = mode.enabled ? noticeFor(isServerTab()) : null;
  el.notice.hidden = !notice;
  if (!notice) {
    el.noticeText.textContent = '';
    el.noticeActions.replaceChildren();
    return;
  }
  el.notice.dataset.kind = notice.key;
  el.noticeText.textContent = tr(notice.key);
  el.noticeActions.replaceChildren(...notice.actions.map(([key, handler]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'server-notice-btn';
    button.textContent = tr(key);
    button.addEventListener('click', () => {
      try {
        const result = handler();
        if (result?.catch) result.catch(showLocalError);
      } catch {
        showLocalError();
      }
    });
    return button;
  }));
}

function renderSync() {
  const show = mode.enabled && isServerTab();
  el.sync.hidden = !show;
  if (!show) return;
  const kind = syncKind();
  el.sync.dataset.kind = kind.toLowerCase();
  el.sync.textContent = tr(`sync${kind}`);
  el.sync.title = tr(`sync${kind}Title`);
}

function renderModebar() {
  el.toggle.checked = mode.enabled;
  el.settingsBtn.hidden = !mode.enabled;
  el.settingsBtn.title = tr('settingsTitle');
  el.openTab.hidden = !mode.enabled || Boolean(sidepadServerTabId());
  el.openTab.textContent = tr('openServerTab');
  if (mode.enabled) el.hint.hidden = true;
}

function renderSettings() {
  if (!mode.enabled) {
    el.settings.hidden = true;
    return;
  }
  const snapshot = auth.snapshot();
  const connected = snapshot.phase === 'current';
  el.connLabel.textContent = tr('settingsConnection');
  el.connState.textContent = connected
    ? tr('settingsConnected').replace('{id}', `${(snapshot.credentialId || '').slice(0, 8)}…`)
    : tr('settingsDisconnected');
  el.connect.textContent = tr('settingsConnect');
  el.forget.textContent = tr('settingsForget');
  el.forget.hidden = snapshot.phase === 'missing';
  el.forgetHint.textContent = tr('settingsForgetHint');
  el.forgetHint.hidden = el.forget.hidden;
  el.legacyLabel.textContent = tr('settingsLegacy');
  el.legacyPrompt.textContent = tr('settingsLegacyPrompt');
  el.legacyPrompt.hidden = ui.legacyChoice !== undefined;
  el.legacySave.textContent = tr('settingsLegacySave');
  renderLegacyOptions();
  el.recoverySummary.textContent = tr('settingsRecovery');
  el.recoveryHint.textContent = tr('settingsRecoveryHint');
  el.pairingIdLabel.textContent = tr('pairingId');
  el.pairingCodeLabel.textContent = tr('pairingCode');
  el.pairingLabelLabel.textContent = tr('pairingLabel');
  el.pair.textContent = tr('pairingSubmit');
}

function renderLegacyOptions() {
  const fileTabs = sidepadFileTabs();
  const current = el.legacySelect.value;
  const options = [{ id: '', title: tr('settingsLegacyNone') }, ...fileTabs.map((tab) => ({
    id: tab.id,
    title: tab.title.toLowerCase().endsWith('.md') ? tab.title : `${tab.title}.md`,
  }))];
  const signature = JSON.stringify(options);
  if (el.legacySelect.dataset.signature !== signature) {
    el.legacySelect.replaceChildren(...options.map((option) => {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.title;
      return node;
    }));
    el.legacySelect.dataset.signature = signature;
  }
  let selected;
  if (ui.legacyChoice === undefined) {
    // Первое подключение: exact dop.md только предлагается, сохраняет пользователь.
    selected = el.legacySelect.dataset.touched ? current : (fileTabs.find((tab) => tab.title === 'dop' || tab.title === 'dop.md')?.id || '');
  } else {
    selected = el.legacySelect.dataset.touched ? current : (ui.legacyChoice || '');
  }
  el.legacySelect.value = options.some((option) => option.id === selected) ? selected : '';
}

function renderChrome() {
  renderModebar();
  renderSync();
  renderNotice();
  renderSettings();
}

/* ── Legacy dop.md choice ── */

function applyLegacyChoice() {
  const fileTabs = sidepadFileTabs();
  backend.legacyTabId = ui.legacyChoice && fileTabs.some((tab) => tab.id === ui.legacyChoice) ? ui.legacyChoice : null;
}

function setLegacyChoice(tabId) {
  ui.legacyChoice = tabId;
  delete el.legacySelect.dataset.touched;
  applyLegacyChoice();
  localStore.set({ [LEGACY_CHOICE_KEY]: { tabId } }).catch(() => {});
  sidepadRender();
}

el.legacySelect.addEventListener('change', () => { el.legacySelect.dataset.touched = '1'; });
el.legacySave.addEventListener('click', () => {
  setLegacyChoice(el.legacySelect.value || null);
  if (ui.legacyChoice !== undefined && authPhase() === 'current') el.settings.hidden = true;
});

/* ── Connection ── */

async function startConnect() {
  const granted = await permissions.contains(ORIGIN_PERMISSION) || await permissions.request(ORIGIN_PERMISSION);
  if (!granted) {
    showHint('permissionDenied');
    return;
  }
  await beginConnectAttempt({ storage: localStore });
  ui.pending = true;
  renderChrome();
  chrome.tabs.create({ url: connectUrl(chrome.runtime.id) });
}

async function refreshPending() {
  ui.pending = Boolean(await activeConnectAttempt({ storage: localStore }));
}

async function retryAmbiguous() {
  await mode.retryAmbiguous();
  if (mode.state.phase === 'conflict' && mode.state.conflictReason !== 'ambiguous') {
    notify(mode.state.conflictReason === 'rejected' ? 'noticeRejected' : 'noticeConflict');
    await mode.refresh({ quiet: true });
  }
}

function openServerTab() {
  ui.tabClosed = false;
  localStore.remove([SERVER_TAB_CLOSED_KEY]).catch(() => {});
  sidepadAttachServer(backend, SERVER_TAB, { focus: true });
  applySnapshot({ force: true });
  return SERVER_TAB_ID;
}

function showHint(key) {
  el.hint.textContent = tr(key);
  el.hint.hidden = false;
}

function showLocalError() {
  notify('noticeRejected');
}

async function activate({ focus }) {
  const stored = await localStore.get([LEGACY_CHOICE_KEY, SERVER_TAB_CLOSED_KEY]);
  ui.legacyChoice = stored[LEGACY_CHOICE_KEY] ? stored[LEGACY_CHOICE_KEY].tabId : undefined;
  ui.tabClosed = stored[SERVER_TAB_CLOSED_KEY] === true;
  applyLegacyChoice();
  await refreshPending();
  sidepadAttachServer(backend, SERVER_TAB, { focus: focus && !ui.tabClosed, show: !ui.tabClosed });
  ui.appliedRevision = null;
  applySnapshot({ force: true });
  if (ui.legacyChoice === undefined) el.settings.hidden = false;
  renderChrome();
  poller.start();
}

async function deactivate() {
  poller.stop();
  ui.queue = [];
  ui.notice = null;
  ui.appliedRevision = null;
  ui.pending = false;
  await cancelConnectAttempt(localStore).catch(() => {});
  await localStore.remove([SERVER_TAB_CLOSED_KEY]).catch(() => {});
  backend.legacyTabId = null;
  el.settings.hidden = true;
  sidepadDetachServer();
  renderChrome();
}

/* ── Events ── */

el.toggle.addEventListener('change', async () => {
  try {
    if (el.toggle.checked) {
      const enabled = await mode.enable();
      if (!enabled) {
        el.toggle.checked = false;
        showHint('permissionDenied');
        return;
      }
      await activate({ focus: true });
      if (!auth.hasCredential()) await startConnect();
    } else {
      await mode.disable();
      await deactivate();
    }
  } catch {
    el.toggle.checked = mode.enabled;
    showLocalError();
  }
});

el.settingsBtn.addEventListener('click', () => {
  el.settings.hidden = !el.settings.hidden;
  renderChrome();
});
el.openTab.addEventListener('click', () => openServerTab());
el.connect.addEventListener('click', () => startConnect().catch(showLocalError));
el.forget.addEventListener('click', () => mode.resetAuth().catch(showLocalError));

el.pairingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pairing = {
    pairingId: el.pairingId.value.trim(),
    code: el.pairingCode.value,
    label: el.pairingLabel.value.trim(),
  };
  el.pairingId.value = '';
  el.pairingCode.value = '';
  try {
    await mode.pair(pairing);
    el.settings.hidden = ui.legacyChoice === undefined ? false : true;
  } catch {
    showHint('pairingFailed');
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !mode.enabled) return;
  if (changes[API_CREDENTIAL_STORAGE_KEY]) {
    const wasConnected = authPhase() === 'current';
    mode.reloadAuth().then(() => {
      if (!wasConnected && auth.hasCredential()) notify('noticeConnected');
    }).catch(showLocalError);
  }
  if (changes[CONNECT_PENDING_STORAGE_KEY]) {
    refreshPending().then(renderChrome).catch(() => {});
  }
});

mode.subscribe(onModeChange);

sidepadReady
  .then(() => mode.init())
  .then(async () => {
    if (mode.enabled) await activate({ focus: false });
    else renderChrome();
  })
  .catch(showLocalError);
