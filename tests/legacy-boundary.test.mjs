// Инвариант S03 «без Notes API нет сетевых запросов» проверяется
// поведенчески в tests/browser/legacy-ui.test.mjs; здесь — статические
// границы, которые не требуют браузера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

test('legacy code loads before the API controller module', async () => {
  const html = await read('popup.html');
  assert.ok(html.indexOf('<script src="popup.js"></script>') < html.indexOf('<script type="module" src="popup-api.js"></script>'));
});

test('update banner opens the bundled installer instead of a GitHub page', async () => {
  const html = await read('popup.html');
  const source = await read('popup.js');
  assert.match(html, /<button[^>]+id="updateBannerText"/);
  assert.match(source, /chrome\.runtime\.getURL\('installer\.html'\)/);
  assert.match(source, /releases\/latest/);
  assert.doesNotMatch(source, /MANIFEST_RAW_URL|const REPO_URL/);
});

test('there is a single Sidepad UI: no separate API application remains', async () => {
  const html = await read('popup.html');
  assert.match(html, /id="legacyMode"/);
  assert.doesNotMatch(html, /id="apiMode"/);
  assert.doesNotMatch(html, /add via API|api-task-form|api-document/);
});

test('square sections keep 2px gaps and tint both gaps of the selected section', async () => {
  const css = await read('popup.css');
  const source = await read('popup.js');

  assert.match(source, /section-last/);
  assert.match(source, /data-collapsed="\$\{isCollapsed\}"/);
  assert.match(css, /--section-task-gap:\s*2px;/);
  assert.doesNotMatch(css, /\.section-group \+ \.section-group\s*\{[^}]*margin-top:/s);
  const headerStyle = css.match(/\.section-header\s*\{([^}]*)\}/s)?.[1] || '';
  assert.match(headerStyle, /margin:\s*var\(--section-task-gap\) 0;/);
  assert.match(headerStyle, /border:\s*0;/);
  assert.doesNotMatch(headerStyle, /border-bottom:/);
  assert.match(headerStyle, /border-radius:\s*0;/);
  assert.match(css, /\.section-content\s*\{\s*margin:\s*0;/);
  assert.match(css, /\.section-group\.section-picker-target\[data-collapsed="false"\] \.section-content\s*\{[^}]*background:\s*var\(--section-target-bg\);/s);
  assert.match(css, /\.task-item\s*\{[^}]*border-left:\s*1px solid transparent;/s);
  assert.match(css, /\.section-group\.section-picker-target\[data-collapsed="false"\] \.section-header\s*\{[^}]*margin-bottom:\s*0;/s);
  assert.match(css, /\.section-group\.section-picker-target\[data-collapsed="false"\] \.section-content\s*\{[^}]*padding-top:\s*var\(--section-task-gap\);[^}]*padding-bottom:\s*var\(--section-task-gap\);/s);
  assert.match(css, /\.section-group\.section-picker-target\[data-collapsed="false"\] \+ \.section-group \.section-header\s*\{[^}]*margin-top:\s*0;/s);
  assert.match(css, /\.section-header\.sticky-cover-front\s*\{[^}]*box-shadow:\s*0 var\(--section-task-gap\) 0 var\(--section-target-solid\);/s);
  assert.doesNotMatch(css, /calc\(var\(--radius\) \+ 1px\)/);
});

test('noninteractive scroll indicator is packaged and keeps native scrolling as fallback', async () => {
  const css = await read('popup.css');
  const html = await read('popup.html');
  const script = await read('popup-scrollbar.js');
  const pkg = JSON.parse(await read('sidepad-package.json'));

  assert.ok(pkg.files.includes('popup-scrollbar.js'));
  assert.match(html, /id="taskViewport"[\s\S]*id="taskList"[\s\S]*id="taskScrollbar"/);
  assert.match(html, /id="taskScrollbar" aria-hidden="true" hidden/);
  assert.match(html, /<script src="popup-scrollbar\.js"><\/script>/);
  assert.match(css, /\.task-viewport\.overlay-scrollbar-ready \.task-list\s*\{\s*scrollbar-width:\s*none;/);
  assert.match(script, /MutationObserver/);
  assert.match(script, /idleDelay = 800/);
  assert.doesNotMatch(script, /pointerdown|keydown|setPointerCapture/);
  assert.match(css, /\.task-scrollbar-thumb::after\s*\{[^}]*width:\s*2px;/s);
});

test('toolbar cover stays opaque above the scrolling task list', async () => {
  const css = await read('popup.css');

  assert.match(css, /--task-list-top-pad:\s*0px;/);
  assert.match(css, /--section-sticky-inset:\s*0px;/);
  assert.match(css, /\.toolbar\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/s);
  assert.match(css, /\.toolbar::after\s*\{[^}]*content:\s*['"]['"];[^}]*position:\s*absolute;[^}]*top:\s*100%;[^}]*background:\s*var\(--bg\);/s);
  assert.match(css, /height:\s*var\(--sticky-cover-height,\s*calc\(var\(--task-list-top-pad\) \+ var\(--section-sticky-inset\) \+ 35px\)\);/);
  assert.match(css, /\.section-header\.sticky-cover-front\s*\{\s*z-index:\s*3;/);
  assert.match(css, /\.task-list\s*\{[^}]*padding:\s*var\(--task-list-top-pad\) 0 8px;/s);
  assert.match(css, /\.section-header\s*\{[^}]*top:\s*var\(--section-sticky-inset\);/s);
});

test('manifest grants no Notes API host access until the optional permission is requested', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  assert.equal(manifest.permissions.includes('https://notes.lab/*'), false);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['https://notes.lab/*']);
});

test('only the exact Notes Lab origin may message the extension', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  assert.deepEqual(manifest.externally_connectable, { matches: ['https://notes.lab/*'] });
  assert.equal(manifest.key, undefined, 'extension id must stay path-derived');
  assert.equal(manifest.background.type, 'module');
});

test('manual pairing lives only inside the collapsed recovery section and has no credential field', async () => {
  const html = await read('popup.html');
  const recovery = html.slice(html.indexOf('<details class="api-recovery"'), html.indexOf('</details>'));
  assert.match(recovery, /id="apiPairingForm"/);
  assert.equal(html.match(/id="apiPairingForm"/g).length, 1);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(html, /id=["'][^"']*credential/i);
});

test('every new user-visible API string has RU and EN translations', async () => {
  const source = await read('popup.js') + await read('popup-api.js');
  const used = new Set([...source.matchAll(/tr\(['`]([A-Za-z]+)(?:\$\{kind\})?['`]\)/g)].map((match) => match[1]));
  for (const kind of ['Current', 'Saving', 'Loading', 'Offline', 'Conflict', 'Retry', 'Auth', 'Pending']) {
    used.add(`sync${kind}`);
    used.add(`sync${kind}Title`);
  }
  used.delete('sync');
  const popup = await read('popup.js');
  const block = (langKey) => popup.slice(popup.indexOf(`  ${langKey}: {`), popup.indexOf('  },', popup.indexOf(`  ${langKey}: {`)));
  for (const key of used) {
    for (const langKey of ['ru', 'en']) {
      assert.match(block(langKey), new RegExp(`\\b${key}:`), `${langKey}.${key}`);
    }
  }
});
