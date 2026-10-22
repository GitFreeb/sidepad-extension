import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function sha256(name) {
  const contents = await readFile(new URL(name, root));
  return createHash('sha256').update(contents).digest('hex');
}

test('legacy task, navigation, Markdown and file-handle implementation stays byte-identical', async () => {
  assert.equal(await sha256('popup.js'), 'e3109b454eaacab392ed15f9c42e2b27d4e9f0adf3518b1eaae3839184f99c2b');
  assert.equal(await sha256('background.js'), 'b9ca1d466f620a502c6e9f18f920912b2f708d20c4a6730519b8b733c2c5e463');
});

test('legacy code loads before the isolated API module', async () => {
  const html = await readFile(new URL('popup.html', root), 'utf8');
  assert.ok(html.indexOf('<script src="popup.js"></script>') < html.indexOf('<script type="module" src="popup-api.js"></script>'));
  assert.match(html, /id="legacyMode"/);
  assert.match(html, /id="apiMode" hidden/);
});

test('manifest grants no Notes API host access until the optional permission is requested', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.permissions.includes('https://notes.lab/*'), false);
  assert.deepEqual(manifest.optional_host_permissions, ['https://notes.lab/*']);
});
