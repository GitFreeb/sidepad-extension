import { createFetchTransport, RevisionedNotesClient } from './notes-api-client.js';
import { NotesApiMode } from './notes-api-mode.js';

const NOTES_ORIGIN = 'https://notes.lab';
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

const mode = new NotesApiMode({
  storage: { get: storageGet, set: storageSet, remove: storageRemove },
  permissions: {
    contains: (permission) => permissionCall('contains', permission),
    request: (permission) => permissionCall('request', permission),
    remove: (permission) => permissionCall('remove', permission),
  },
  originPermission: ORIGIN_PERMISSION,
  clientFactory: () => new RevisionedNotesClient({
    transport: createFetchTransport({ baseUrl: NOTES_ORIGIN }),
  }),
});

const elements = {
  toggle: document.getElementById('apiModeToggle'),
  hint: document.getElementById('apiModeHint'),
  legacy: document.getElementById('legacyMode'),
  api: document.getElementById('apiMode'),
  status: document.getElementById('apiStatus'),
  meta: document.getElementById('apiMeta'),
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

function noticeFor(state) {
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

function render({ enabled, state }) {
  elements.toggle.checked = enabled;
  if (enabled) elements.hint.hidden = true;
  elements.legacy.hidden = enabled;
  elements.api.hidden = !enabled;
  if (!enabled) return;

  elements.status.textContent = state.phase;
  elements.status.dataset.phase = state.phase;
  elements.notice.textContent = noticeFor(state);
  const revision = state.confirmed?.revision;
  const fetchedAt = state.confirmed?.fetchedAt;
  elements.meta.textContent = revision
    ? `rev ${revision.slice(0, 12)} · ${fetchedAt || 'time unknown'}`
    : 'No confirmed snapshot';

  renderSectionOptions(state.confirmed, state.draft?.sectionName);
  updateFormFromDraft(state.draft);
  renderDocument(state.confirmed);

  const canWrite = state.phase === 'current' && Boolean(revision);
  const canEditDraft = canWrite || (state.phase === 'conflict' && state.conflictReason === 'revision');
  [elements.section, elements.task, elements.url].forEach((element) => { element.disabled = !canEditDraft; });
  elements.submit.disabled = !canWrite || !elements.task.value.trim() || !elements.section.value;
  elements.refresh.disabled = state.phase === 'loading' || state.phase === 'saving';
  if (state.conflictReason === 'ambiguous') elements.refresh.disabled = true;
  elements.retry.hidden = state.conflictReason !== 'ambiguous';
  elements.retry.disabled = state.phase !== 'conflict';
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
