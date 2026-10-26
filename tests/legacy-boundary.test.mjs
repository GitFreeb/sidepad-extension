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

test('there is a single Sidepad UI: no separate API application remains', async () => {
  const html = await read('popup.html');
  assert.match(html, /id="legacyMode"/);
  assert.doesNotMatch(html, /id="apiMode"/);
  assert.doesNotMatch(html, /add via API|api-task-form|api-document/);
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
