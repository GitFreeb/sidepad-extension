import { createFetchTransport, RevisionedNotesClient } from './notes-api-client.js';
import { NotesApiMode } from './notes-api-mode.js';
import { NOTES_ORIGIN, NotesApiAuth, PairingError } from './notes-api-auth.js';

const ORIGIN_PERMISSION = { origins: [`${NOTES_ORIGIN}/*`] };

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (value) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(value);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function permissionCall(method, permission) {
  return new Promise((resolve, reject) => {
    chrome.permissions[method](permission, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(Boolean(result));
    });
  });
}

const localStorage = { get: storageGet, set: storageSet, remove: storageRemove };
const auth = new NotesApiAuth({ storage: localStorage });

const mode = new NotesApiMode({
  storage: localStorage,
  permissions: {
    contains: (permission) => permissionCall('contains', permission),
    request: (permission) => permissionCall('request', permission),
    remove: (permission) => permissionCall('remove', permission),
  },
  originPermission: ORIGIN_PERMISSION,
  auth,
  clientFactory: () => new RevisionedNotesClient({
    transport: createFetchTransport({
      baseUrl: NOTES_ORIGIN,
      authorize: (init, context) => auth.authorizeContentRequest(init, context),
    }),
  }),
});

const elements = {
  toggle: document.getElementById('apiModeToggle'),
  hint: document.getElementById('apiModeHint'),
  legacy: document.getElementById('legacyMode'),
  api: document.getElementById('apiMode'),
  status: document.getElementById('apiStatus'),
  meta: document.getElementById('apiMeta'),
  authPanel: document.getElementById('apiAuthPanel'),
  authState: document.getElementById('apiAuthState'),
  authHelp: document.getElementById('apiAuthHelp'),
  pairingForm: document.getElementById('apiPairingForm'),
  pairingId: document.getElementById('apiPairingIdInput'),
  pairingCode: document.getElementById('apiPairingCodeInput'),
  pairingLabel: document.getElementById('apiPairingLabelInput'),
  pair: document.getElementById('apiPairBtn'),
  authCurrent: document.getElementById('apiAuthCurrent'),
  authMeta: document.getElementById('apiAuthMeta'),
  authResetRow: document.querySelector('.api-auth-reset-row'),
  forgetAuth: document.getElementById('apiForgetAuthBtn'),
  notice: document.getElementById('apiNotice'),
  refresh: document.getElementById('apiRefreshBtn'),
  retry: document.getElementById('apiRetryBtn'),
  copyDraft: document.getElementById('apiCopyDraftBtn'),
  reset: document.getElementById('apiResetBtn'),
  form: document.getElementById('apiTaskForm'),
  section: document.getElementById('apiSectionSelect'),
  task: document.getElementById('apiTaskInput'),
  url: document.getElementById('apiUrlInput'),
  submit: document.getElementById('apiSubmitBtn'),
  document: document.getElementById('apiDocument'),
};

function sectionsFrom(snapshot) {
  return Array.isArray(snapshot?.document?.sections) ? snapshot.document.sections : [];
}

function renderDocument(snapshot) {
  elements.document.replaceChildren();
  const sections = sectionsFrom(snapshot);
  if (!snapshot || sections.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'api-empty';
    empty.textContent = snapshot ? 'The confirmed document has no sections.' : 'No confirmed API snapshot.';
    elements.document.append(empty);
    return;
  }

  sections.forEach((section) => {
    const heading = document.createElement('div');
    heading.className = 'api-section-title';
    heading.textContent = section.name || 'Untitled section';
    elements.document.append(heading);

    const tasks = Array.isArray(section.tasks) ? section.tasks : [];
    tasks.forEach((task) => {
      const row = document.createElement('div');
      row.className = `api-task${task.done ? ' done' : ''}`;
      const mark = document.createElement('span');
      mark.className = 'api-task-mark';
      mark.textContent = task.done ? '☑' : '☐';
      const text = document.createElement('span');
      text.textContent = task.text || '';
      row.append(mark, text);
      elements.document.append(row);
    });
  });
}

function renderSectionOptions(snapshot, selectedName) {
  const sections = sectionsFrom(snapshot);
  const previousName = selectedName || elements.section.value;
  elements.section.replaceChildren();
  if (selectedName && !sections.some((section) => section.name === selectedName)) {
    const missing = document.createElement('option');
    missing.value = '';
    missing.textContent = 'Previous section is unavailable — choose another';
    elements.section.append(missing);
  }
  sections.forEach((section) => {
    const option = document.createElement('option');
    option.value = section.name;
    option.textContent = section.name;
    elements.section.append(option);
  });
  if (sections.some((section) => section.name === previousName)) elements.section.value = previousName;
  else if (selectedName) elements.section.value = '';
}

function noticeFor(state, authState) {
  if (authState?.phase === 'pairing') {
    return 'Exchanging the one-time pairing directly with Notes Lab. The code is not stored.';
  }
  if (authState?.phase !== 'current' && state.conflictReason === 'ambiguous') {
    return 'Pairing is required. The uncertain operation and draft are preserved and will not replay automatically; retry remains manual.';
  }
  if (authState?.phase === 'auth-required') {
    return 'Locked · the saved credential was rejected and removed locally. Re-pair explicitly; no request or mutation is retried.';
  }
  if (authState?.phase === 'missing') {
    return 'Credential missing · create a one-time pairing in the authenticated Notes Lab flow, then connect here.';
  }
  if (state.phase === 'loading') return 'Loading the current revision. Editing stays locked until it is confirmed.';
  if (state.phase === 'saving') return 'Saving one semantic operation with the confirmed revision.';
  if (state.phase === 'offline-read-only') return 'Offline · read-only. Showing the last confirmed snapshot; no operation is queued.';
  if (state.phase === 'auth-required') return 'Locked · authentication required. No task payload was logged or retried.';
  if (state.phase === 'conflict' && state.conflictReason === 'ambiguous') {
    return 'The save response was lost. The draft is preserved. Retry manually with the same operation ID before refreshing.';
  }
  if (state.phase === 'conflict') {
    return 'Stale revision. The draft is preserved; refresh the document, review it, then submit the intent again.';
  }
  return 'Current · writes use semantic operations only. No full Markdown document is sent.';
}

function updateFormFromDraft(draft) {
  if (!draft) return;
  if (document.activeElement !== elements.task) elements.task.value = draft.text || '';
  if (document.activeElement !== elements.url) elements.url.value = draft.url || '';
  if (draft.sectionName) elements.section.value = draft.sectionName;
}

function render({ enabled, state, auth: authState }) {
  elements.toggle.checked = enabled;
  if (enabled) {
    elements.hint.hidden = true;
  } else if (authState?.phase === 'current') {
    elements.hint.textContent = 'API off · local credential retained';
    elements.hint.hidden = false;
  }
  elements.legacy.hidden = enabled;
  elements.api.hidden = !enabled;
  if (!enabled) return;

  const authPhase = authState?.phase || 'missing';
  const displayPhase = authPhase === 'current'
    ? state.phase
    : authPhase === 'missing' ? 'credential-missing' : authPhase;
  elements.status.textContent = displayPhase;
  elements.status.dataset.phase = displayPhase;
  elements.notice.textContent = noticeFor(state, authState);
  elements.authPanel.dataset.phase = authPhase;
  elements.authState.textContent = authPhase === 'current'
    ? 'current'
    : authPhase === 'pairing' ? 'pairing…' : authPhase === 'auth-required' ? 'auth required' : 'credential missing';
  const pairing = authPhase === 'pairing';
  const current = authPhase === 'current';
  elements.authHelp.hidden = current;
  elements.pairingForm.hidden = current;
  [elements.pairingId, elements.pairingCode, elements.pairingLabel, elements.pair].forEach((element) => {
    element.disabled = pairing;
  });
  elements.authCurrent.hidden = !current;
  elements.authResetRow.hidden = authPhase === 'missing' || pairing;
  const credentialId = authState?.credentialId;
  const scopes = Array.isArray(authState?.scopes) ? authState.scopes.join(' · ') : '';
  elements.authMeta.textContent = credentialId
    ? `client ${credentialId.slice(0, 8)}…${scopes ? ` · ${scopes}` : ''}`
    : 'Paired locally';
  const revision = state.confirmed?.revision;
  const fetchedAt = state.confirmed?.fetchedAt;
  elements.meta.textContent = revision
    ? `rev ${revision.slice(0, 12)} · ${fetchedAt || 'time unknown'}`
    : 'No confirmed snapshot';

  renderSectionOptions(state.confirmed, state.draft?.sectionName);
  updateFormFromDraft(state.draft);
  renderDocument(state.confirmed);

  const canWrite = authPhase === 'current' && state.phase === 'current' && Boolean(revision);
  const canEditDraft = canWrite || (state.phase === 'conflict' && state.conflictReason === 'revision');
  [elements.section, elements.task, elements.url].forEach((element) => { element.disabled = !canEditDraft; });
  elements.submit.disabled = !canWrite || !elements.task.value.trim() || !elements.section.value;
  elements.refresh.disabled = authPhase !== 'current' || state.phase === 'loading' || state.phase === 'saving';
  if (state.conflictReason === 'ambiguous') elements.refresh.disabled = true;
  elements.retry.hidden = state.conflictReason !== 'ambiguous';
  elements.retry.disabled = state.phase !== 'conflict' || authPhase !== 'current';
  elements.copyDraft.disabled = !state.draft;
}

function currentDraft() {
  return {
    kind: 'task.create',
    sectionName: elements.section.value,
    text: elements.task.value,
    url: elements.url.value,
  };
}

function showLocalError() {
  elements.notice.textContent = 'The experimental client stopped on an unexpected local error.';
  elements.status.textContent = 'error';
  elements.status.dataset.phase = 'conflict';
}

mode.subscribe(render);

elements.toggle.addEventListener('change', async () => {
  try {
    if (elements.toggle.checked) {
      const enabled = await mode.enable();
      if (!enabled) {
        elements.toggle.checked = false;
        elements.hint.textContent = mode.lastEnableReason === 'legacy-auto-save'
          ? 'turn off ↓auto first'
          : 'permission not granted';
        elements.hint.hidden = false;
      }
    } else {
      await mode.disable();
    }
  } catch {
    elements.toggle.checked = mode.enabled;
    showLocalError();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !mode.enabled || !changes.tabs?.newValue?.some((tab) => tab.autoSave)) return;
  mode.disable().catch(showLocalError);
});

elements.refresh.addEventListener('click', () => mode.refresh().catch(showLocalError));
elements.retry.addEventListener('click', () => mode.retryAmbiguous().catch(showLocalError));
elements.reset.addEventListener('click', async () => {
  try {
    await mode.disable();
  } catch {
    showLocalError();
  }
});

elements.pairingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pairing = {
    pairingId: elements.pairingId.value.trim(),
    code: elements.pairingCode.value,
    label: elements.pairingLabel.value.trim(),
  };
  try {
    const attempt = mode.pair(pairing);
    elements.pairingId.value = '';
    elements.pairingCode.value = '';
    await attempt;
  } catch (error) {
    if (!(error instanceof PairingError)) {
      showLocalError();
      return;
    }
    const messages = {
      'invalid-input': 'Enter the complete pairing ID, one-time code and a label up to 80 characters.',
      'invalid-or-expired': 'The pairing is invalid, expired or already used. Create a new one in Notes Lab.',
      'origin-forbidden': 'Notes Lab rejected this extension origin. Pairing remains locked.',
      offline: 'Notes Lab is unavailable. No pairing data was saved; try again manually.',
      'invalid-response': 'Notes Lab returned an invalid pairing response. No credential was saved.',
      'storage-failed': 'The issued credential could not be saved locally. Revoke it in Notes Lab and create a new pairing.',
      'service-unavailable': 'Notes Lab could not complete pairing. Try again manually.',
    };
    elements.notice.textContent = messages[error.reason] || 'Pairing failed safely. Try again manually.';
  }
});

elements.forgetAuth.addEventListener('click', () => mode.resetAuth().catch(showLocalError));

[elements.section, elements.task, elements.url].forEach((element) => {
  element.addEventListener('input', () => mode.setDraft(currentDraft()).catch(showLocalError));
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const draft = currentDraft();
  const section = sectionsFrom(mode.state.confirmed).find((item) => item.name === draft.sectionName);
  if (!section?.ref || !draft.text.trim()) return;
  try {
    await mode.setDraft(draft);
    const saved = await mode.submit({
      type: 'task.create',
      section_ref: section.ref,
      task: { text: draft.text.trim(), url: draft.url.trim() || null },
    });
    if (saved) {
      elements.task.value = '';
      elements.url.value = '';
      render(mode.snapshot());
    }
  } catch {
    showLocalError();
  }
});

elements.copyDraft.addEventListener('click', async () => {
  if (!mode.state.draft) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(mode.state.draft, null, 2));
    elements.notice.textContent = 'Draft copied locally.';
  } catch {
    showLocalError();
  }
});

mode.init().catch(showLocalError);
