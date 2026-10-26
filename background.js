import { NotesApiAuth } from './notes-api-auth.js';
import { createExternalMessageHandler } from './notes-api-connect.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

const storage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (value) => chrome.storage.local.set(value),
  remove: (keys) => chrome.storage.local.remove(keys),
};

// Обмен одноразового кода выполняет сам service worker: код не проходит
// через панель, а credential сохраняется только в storage.local.
const handleExternalMessage = createExternalMessageHandler({
  storage,
  runtimeId: chrome.runtime.id,
  exchange: async (pairing) => {
    await new NotesApiAuth({ storage }).exchange(pairing);
  },
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleExternalMessage(message, sender).then(sendResponse);
  return true;
});
