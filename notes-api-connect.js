// Сторона расширения в протоколе автоподключения S12A: Sidepad открывает
// https://notes.lab/#sidepad-connect=<id>, web спрашивает probe/pair через
// externally_connectable. Принимается только https://notes.lab при активной
// pending-попытке; одноразовый код и credential не попадают в логи и ответы.
import { NOTES_ORIGIN } from './notes-api-auth.js';

export const CONNECT_PENDING_STORAGE_KEY = 'notesApiConnectPendingV1';
export const CONNECT_TTL_MS = 10 * 60 * 1000;

const EXTENSION_ID = /^[a-p]{32}$/;
const PROBE_TYPE = 'notes-lab.connect.probe';
const PAIR_TYPE = 'notes-lab.connect.pair';
const PROBE_KEYS = ['notes_origin', 'type'];
const PAIR_KEYS = ['code', 'label', 'notes_origin', 'pairing_id', 'type'];
const REJECT = Object.freeze({ ok: false });

export function connectUrl(extensionId) {
  if (!EXTENSION_ID.test(extensionId || '')) throw new TypeError('Invalid extension id.');
  return `${NOTES_ORIGIN}/#sidepad-connect=${extensionId}`;
}

export async function beginConnectAttempt({ storage, now = Date.now }) {
  const expiresAt = now() + CONNECT_TTL_MS;
  await storage.set({ [CONNECT_PENDING_STORAGE_KEY]: { version: 1, expiresAt } });
  return expiresAt;
}

export async function cancelConnectAttempt(storage) {
  await storage.remove([CONNECT_PENDING_STORAGE_KEY]);
}

export async function activeConnectAttempt({ storage, now = Date.now }) {
  const stored = (await storage.get([CONNECT_PENDING_STORAGE_KEY]))[CONNECT_PENDING_STORAGE_KEY];
  if (stored === undefined) return null;
  const current = now();
  const valid = stored
    && stored.version === 1
    && Number.isFinite(stored.expiresAt)
    && stored.expiresAt > current
    && stored.expiresAt - current <= CONNECT_TTL_MS;
  if (!valid) {
    await cancelConnectAttempt(storage);
    return null;
  }
  return { expiresAt: stored.expiresAt };
}

export function browserLabel(nav = globalThis.navigator) {
  const brands = (nav?.userAgentData?.brands || []).map((entry) => entry.brand);
  const names = [['Brave', 'Brave'], ['Microsoft Edge', 'Edge'], ['Opera', 'Opera'], ['Vivaldi', 'Vivaldi'], ['Google Chrome', 'Chrome']];
  const match = names.find(([brand]) => brands.includes(brand));
  const name = match ? match[1] : 'Chromium';
  const platform = nav?.userAgentData?.platform;
  return platform ? `${name} · ${platform}` : name;
}

function exactShape(message, keys) {
  return Boolean(message)
    && typeof message === 'object'
    && !Array.isArray(message)
    && Object.getPrototypeOf(message) === Object.prototype
    && Object.keys(message).sort().join(',') === keys.join(',')
    && message.notes_origin === NOTES_ORIGIN;
}

function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
}

function validPair(message) {
  return exactShape(message, PAIR_KEYS)
    && boundedString(message.pairing_id, 128)
    && boundedString(message.code, 256)
    && boundedString(message.label, 80);
}

export function createExternalMessageHandler({ storage, runtimeId, browser = browserLabel, now = Date.now, exchange }) {
  let pairing = false;

  return async function handleExternalMessage(message, sender) {
    try {
      if (sender?.origin !== NOTES_ORIGIN) return REJECT;
      if (exactShape(message, PROBE_KEYS) && message.type === PROBE_TYPE) {
        const attempt = await activeConnectAttempt({ storage, now });
        if (!attempt) return REJECT;
        return {
          ok: true,
          extension_id: runtimeId,
          name: 'Sidepad',
          browser: browser(),
          pending_expires_at: Math.floor(attempt.expiresAt / 1000),
        };
      }
      if (!validPair(message) || message.type !== PAIR_TYPE || pairing) return REJECT;
      pairing = true;
      try {
        if (!(await activeConnectAttempt({ storage, now }))) return REJECT;
        await exchange({ pairingId: message.pairing_id, code: message.code, label: message.label });
        await cancelConnectAttempt(storage);
        return { ok: true };
      } finally {
        pairing = false;
      }
    } catch {
      return REJECT;
    }
  };
}
