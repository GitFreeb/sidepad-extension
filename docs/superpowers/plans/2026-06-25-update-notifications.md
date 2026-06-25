# Оповещения об обновлениях Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показывать пользователю, что вышла более новая версия Sidepad на GitHub, чем установленная локально (расширение распространяется только как unpacked, без Chrome Web Store).

**Architecture:** При каждом открытии side panel `popup.js` сравнивает локальную версию (`chrome.runtime.getManifest().version`) с версией `manifest.json` из ветки `main` на GitHub (запрос раз в 24 часа, кэш в `chrome.storage.local`). Если на GitHub версия новее — показывается баннер в панели и бейдж на иконке расширения; крестик скрывает баннер, но не бейдж, до реального обновления.

**Tech Stack:** Vanilla JS (без сборки), `chrome.storage.local`, `chrome.action` (badge), `fetch` к `raw.githubusercontent.com`, `chrome.tabs.create`.

## Global Constraints

- Никаких новых записей в `permissions` или `host_permissions` в `manifest.json` — `raw.githubusercontent.com` отдаёт `Access-Control-Allow-Origin: *`, `chrome.action`/`chrome.tabs.create` не требуют доп. permissions.
- Никаких `chrome.alarms` / фоновых проверок в `background.js` — проверка только при открытии панели (`loadAll()`), throttled на 24 часа через `chrome.storage.local`.
- Сравнение версий — числовое по сегментам, не строковое (`"1.10"` > `"1.9"`).
- Сетевые ошибки проглатываются молча — без консоли с ошибками, без падения панели.
- Все строки UI — через таблицу `I18N` (`ru`/`en`) и `tr(key)`, как остальной интерфейс.
- После реализации — обновить `Sidepad/../.claude/CLAUDE.md` (раздел «Ключевые архитектурные решения») новым подпунктом, описывающим механизм.

---

## Контекст кодовой базы (для исполнителя)

- `popup.js` — вся логика. `I18N` (объекты `ru`/`en`) — строки 6–65, `tr(key)` — строка 69. `applyLang(l, save=true)` — строки 80–100, последний блок:
  ```js
  if (save) {
    chrome.storage.local.set({ lang: l });
    render();
  }
  ```
- `loadAll()` (строки 338–367) читает `chrome.storage.local`, в конце callback-а:
  ```js
    resetCollapsedState();
    renderTabs();
    render();
  });
  }
  ```
- В самом низу файла, после блока `/* ── Tab overflow indicator ── */`, идёт:
  ```js
  /* ── Init ── */
  loadAll();
  ```
- Существующий паттерн открытия вкладки (строка 960):
  ```js
  chrome.tabs.create({ url: e.target.closest('[data-action="link"]').href });
  ```
- `popup.html`: блок `<div class="tabbar">...</div>` заканчивается, сразу после него комментарий `<!-- Status / breadcrumb -->` и `<div class="breadcrumb">`.
- `popup.css`: переменные темы определены в `:root` и `[data-theme="light"]` (строки 1–48). Используемые переменные: `--accent`, `--accent-glow`, `--text-muted`, `--text`, `--border`.
- В проекте нет тестовой инфраструктуры (vanilla JS, без сборки и без test runner) — проверка каждой задачи делается вручную: перезагрузка unpacked-расширения в `chrome://extensions` и проверка через DevTools консоль открытой side panel (правый клик на панели → "Inspect").

---

### Task 1: Сравнение версий и константы

**Files:**
- Modify: `popup.js` (новый блок сразу после `const LEGACY_DEFAULT_SECTIONS = ...;`, строка 71)

**Interfaces:**
- Produces: `compareVersions(a: string, b: string): number` (−1 / 0 / 1), `UPDATE_CHECK_INTERVAL_MS: number`, `MANIFEST_RAW_URL: string`, `REPO_URL: string` — используются в Task 2.

- [ ] **Step 1: Добавить константы и функцию сравнения версий**

В `popup.js` сразу после строки:
```js
const LEGACY_DEFAULT_SECTIONS = new Set(['__default__', 'Дополнительные задачи', 'Extra tasks']);
```
вставить:
```js
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
```

- [ ] **Step 2: Проверить вручную через консоль**

Перезагрузить unpacked-расширение в `chrome://extensions`, открыть side panel, открыть DevTools для панели (правый клик внутри панели → Inspect), во вкладке Console выполнить:
```js
compareVersions('1.10', '1.9')   // ожидаем 1
compareVersions('1.3', '1.3')    // ожидаем 0
compareVersions('1.3', '1.4')    // ожидаем -1
```
Ожидаемый результат: значения совпадают с комментариями. Если `compareVersions is not defined` — проверить, что блок вставлен на верхнем уровне файла (не внутри другой функции).

- [ ] **Step 3: Commit**

```bash
git add popup.js
git commit -m "feat: add version comparison helper for update checks"
```

---

### Task 2: Логика проверки обновления (без UI)

**Files:**
- Modify: `popup.js` (новый блок сразу после функции из Task 1, плюс вызов в `loadAll()`)

**Interfaces:**
- Consumes: `compareVersions(a, b)`, `UPDATE_CHECK_INTERVAL_MS`, `MANIFEST_RAW_URL` (Task 1).
- Produces: module-level `let updateInfo = { lastChecked, latestVersion, dismissedVersion }`; функция `checkForUpdate(): void`. `updateInfo` и `checkForUpdate` используются в Task 3 для рендера баннера/бейджа.

- [ ] **Step 1: Добавить состояние и функцию `checkForUpdate`**

Сразу после функции `compareVersions` (добавленной в Task 1) вставить:
```js
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
  // implemented in Task 3
}
```

- [ ] **Step 2: Вызвать `checkForUpdate()` из `loadAll()`**

В `popup.js` найти конец `loadAll()`:
```js
    resetCollapsedState();
    renderTabs();
    render();
  });
}
```
заменить на:
```js
    resetCollapsedState();
    renderTabs();
    render();
    checkForUpdate();
  });
}
```

- [ ] **Step 3: Проверить throttle и фетч вручную**

Перезагрузить расширение, открыть side panel, в DevTools-консоли панели:
```js
chrome.storage.local.get(['updateInfo'], console.log)
```
Ожидаемый результат: объект `updateInfo` с `lastChecked` ≈ текущее время (только что выставлено), `latestVersion` равно текущей версии манифеста (т.к. в `main` версия не отличается), `dismissedVersion: ''`.

Затем во вкладке Network DevTools убедиться, что был запрос к `raw.githubusercontent.com/.../manifest.json` со статусом 200.

Закрыть и снова открыть панель сразу же — в Network НЕ должно быть повторного запроса (throttle 24ч), `lastChecked` в storage не изменился.

Для проверки сценария "новая версия доступна" временно выполнить в консоли:
```js
chrome.storage.local.set({ updateInfo: { lastChecked: Date.now(), latestVersion: '999.0', dismissedVersion: '' } })
```
и перезапустить `checkForUpdate()` командой `checkForUpdate()` в консоли — убедиться, что throttle сработал (т.к. `lastChecked` свежий) и `latestVersion` осталось `999.0` (баннера пока не будет — рендер появится в Task 3).

- [ ] **Step 4: Commit**

```bash
git add popup.js
git commit -m "feat: add throttled update check against GitHub manifest"
```

---

### Task 3: Баннер в панели и бейдж на иконке

**Files:**
- Modify: `popup.html` (разметка баннера после `.tabbar`)
- Modify: `popup.css` (стили `.update-banner`)
- Modify: `popup.js` (строки I18N, реализация `renderUpdateBanner()`)

**Interfaces:**
- Consumes: `updateInfo`, `checkForUpdate()` (Task 2); `tr(key)` (existing).
- Produces: полностью реализованная `renderUpdateBanner()`, обновляет DOM-элементы `#updateBanner`, `#updateBannerText` и бейдж иконки. Используется в Task 4 (клики) без изменений сигнатуры.

- [ ] **Step 1: Добавить разметку баннера в `popup.html`**

Найти в `popup.html`:
```html
    <!-- Status / breadcrumb -->
    <div class="breadcrumb">
```
Вставить новый блок прямо перед ним (внутри `.app`, после закрывающего `</div>` блока `.tabbar`):
```html
    <!-- Update notification -->
    <div class="update-banner" id="updateBanner" hidden>
      <span class="update-banner-text" id="updateBannerText"></span>
      <button class="update-banner-close" id="updateBannerClose" title="Скрыть">×</button>
    </div>

    <!-- Status / breadcrumb -->
    <div class="breadcrumb">
```

- [ ] **Step 2: Добавить стили в `popup.css`**

Найти блок `.breadcrumb { ... }` (строка 316) и сразу перед ним вставить:
```css
.update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 16px;
  background: var(--accent-glow);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.update-banner[hidden] { display: none; }

.update-banner-text {
  color: var(--accent);
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.update-banner-text:hover { text-decoration: underline; }

.update-banner-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
}

.update-banner-close:hover { color: var(--text); }
```

- [ ] **Step 3: Добавить строки в `I18N`**

В `popup.js` в объект `ru` (строки 6–35) добавить перед закрывающей `}`:
```js
    updateAvailable:      'Доступна версия {version} → Обновить',
    updateBannerClose:    'Скрыть',
```
В объект `en` (строки 36–65) добавить перед закрывающей `}`:
```js
    updateAvailable:      'Version {version} is available → Update',
    updateBannerClose:    'Dismiss',
```

- [ ] **Step 4: Реализовать `renderUpdateBanner()`**

Заменить заглушку из Task 2:
```js
function renderUpdateBanner() {
  // implemented in Task 3
}
```
на:
```js
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
```

- [ ] **Step 5: Проверить вручную**

Перезагрузить расширение, открыть side panel, в консоли:
```js
updateInfo = { lastChecked: Date.now(), latestVersion: '999.0', dismissedVersion: '' };
renderUpdateBanner();
```
Ожидаемый результат: в панели между tabbar и breadcrumb появляется баннер «Доступна версия 999.0 → Обновить», на иконке расширения в тулбаре браузера появляется оранжевый бейдж-точка.

Затем:
```js
updateInfo.latestVersion = chrome.runtime.getManifest().version;
renderUpdateBanner();
```
Ожидаемый результат: баннер скрывается (`#updateBanner` получает атрибут `hidden`), бейдж на иконке исчезает.

- [ ] **Step 6: Commit**

```bash
git add popup.html popup.css popup.js
git commit -m "feat: render update banner and toolbar badge when newer version is available"
```

---

### Task 4: Клики — переход на GitHub и скрытие баннера

**Files:**
- Modify: `popup.js` (новые слушатели событий рядом с блоком `/* ── Tab overflow indicator ── */`)

**Interfaces:**
- Consumes: `REPO_URL` (Task 1), `updateInfo`, `renderUpdateBanner()` (Tasks 2–3), существующий паттерн `chrome.tabs.create({ url })` (строка 960 файла на момент написания плана).
- Produces: финальное интерактивное поведение баннера — ничего нового не потребляется задачами после этой.

- [ ] **Step 1: Добавить слушатели клика и закрытия**

В `popup.js` найти:
```js
/* ── Tab overflow indicator ── */
(function () {
```
и вставить непосредственно перед этим блоком:
```js
/* ── Update banner interactions ── */
document.getElementById('updateBannerText').addEventListener('click', () => {
  chrome.tabs.create({ url: REPO_URL });
});

document.getElementById('updateBannerClose').addEventListener('click', (e) => {
  e.stopPropagation();
  updateInfo.dismissedVersion = updateInfo.latestVersion;
  chrome.storage.local.set({ updateInfo });
  renderUpdateBanner();
});
```

- [ ] **Step 2: Подключить тултип крестика к i18n**

В `applyLang(l, save = true)` (строки 80–100) найти конец функции:
```js
  if (save) {
    chrome.storage.local.set({ lang: l });
    render();
  }
}
```
заменить на:
```js
  document.getElementById('updateBannerClose').title = tr('updateBannerClose');
  if (save) {
    chrome.storage.local.set({ lang: l });
    render();
    renderUpdateBanner();
  }
}
```
(Обновление `title` крестика выполняется всегда при смене языка; пересчёт текста баннера через `renderUpdateBanner()` — только при пользовательском переключении языка (`save === true`), чтобы не дёргать баннер во время начальной тихой загрузки в `loadAll()`.)

- [ ] **Step 3: Проверить вручную — клик по баннеру**

Повторить шаги из Task 3 Step 5, чтобы баннер был виден (`updateInfo.latestVersion = '999.0'; renderUpdateBanner();`). Кликнуть по тексту баннера.
Ожидаемый результат: открывается новая вкладка браузера с `https://github.com/GitFreeb/sidepad-extension`.

- [ ] **Step 4: Проверить вручную — крестик**

С тем же видимым баннером кликнуть «×».
Ожидаемый результат: баннер скрывается, бейдж на иконке остаётся. Выполнить в консоли `chrome.storage.local.get(['updateInfo'], console.log)` — `dismissedVersion` равен `'999.0'`. Закрыть и заново открыть side panel — баннер не появляется снова (для той же версии), бейдж по-прежнему виден.

- [ ] **Step 5: Проверить вручную — переключение языка**

С видимым баннером нажать кнопку `RU`/`EN` в тулбаре.
Ожидаемый результат: текст баннера переключается между «Доступна версия 999.0 → Обновить» и «Version 999.0 is available → Update» без перезагрузки панели.

- [ ] **Step 6: Commit**

```bash
git add popup.js
git commit -m "feat: wire update banner click-through and dismiss behavior"
```

---

### Task 5: Финальная сквозная проверка и документация

**Files:**
- Modify: `/Users/denisivanov/Documents/Claude/Sidepad extension/.claude/CLAUDE.md` (раздел «Ключевые архитектурные решения»)

**Interfaces:**
- Consumes: весь функционал из Tasks 1–4.
- Produces: нет (финальная задача).

- [ ] **Step 1: Сбросить тестовое состояние**

В консоли DevTools открытой панели:
```js
chrome.storage.local.remove('updateInfo')
chrome.action.setBadgeText({ text: '' })
```

- [ ] **Step 2: Пройти полный сценарий по спеке (`docs/superpowers/specs/2026-06-25-update-notifications-design.md`, раздел «Тестирование»)**

1. Временно отредактировать `version` в локальном `manifest.json` на `0.1`, перезагрузить unpacked-расширение в `chrome://extensions`, открыть панель. Ожидаемый результат: т.к. версия на GitHub (`1.3`+) выше локальной `0.1`, появляются баннер и бейдж.
2. Закрыть баннер крестиком — баннер скрылся, бейдж остался; закрыть и заново открыть панель — баннер не появился повторно.
3. Вернуть `version` в `manifest.json` обратно на исходное значение, перезагрузить расширение, очистить `updateInfo` (Step 1) и снова открыть панель — баннер и бейдж не появляются (локальная версия не отстаёт от GitHub).
4. Отключить Wi-Fi/сеть, очистить `updateInfo`, открыть панель — никаких ошибок в консоли, баннер не появляется, панель работает как обычно. Включить сеть обратно.
5. Переключить RU/EN при видимом баннере (повторно проверено в Task 4 Step 5) — текст меняется.

- [ ] **Step 3: Обновить `CLAUDE.md`**

В файле `/Users/denisivanov/Documents/Claude/Sidepad extension/.claude/CLAUDE.md`, в разделе «## Ключевые архитектурные решения», добавить в конец новый блок:
```markdown
**Оповещение об обновлениях:** расширение распространяется только как unpacked (без Chrome Web Store), поэтому проверка обновлений реализована вручную в `popup.js`. При каждом открытии панели `loadAll()` вызывает `checkForUpdate()`: сравнивает `chrome.runtime.getManifest().version` с полем `version` из `manifest.json` ветки `main` на GitHub (`MANIFEST_RAW_URL`, числовое сравнение через `compareVersions`). Результат кэшируется в `chrome.storage.local.updateInfo = { lastChecked, latestVersion, dismissedVersion }`, повторный сетевой запрос — не чаще раза в `UPDATE_CHECK_INTERVAL_MS` (24 часа), независимо от успеха/неудачи запроса. Если доступна более новая версия — `renderUpdateBanner()` показывает баннер `#updateBanner` (между tabbar и breadcrumb) и бейдж на иконке через `chrome.action.setBadgeText`. Клик по баннеру открывает `REPO_URL` на GitHub; крестик скрывает баннер (`dismissedVersion = latestVersion`), но не бейдж — тот гаснет только когда локальная версия фактически догоняет `latestVersion`.
```

- [ ] **Step 4: Commit**

```bash
git add "/Users/denisivanov/Documents/Claude/Sidepad extension/.claude/CLAUDE.md"
git commit -m "docs: document update-notification mechanism in CLAUDE.md"
```
