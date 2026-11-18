import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, browserExecutable } from './cdp.mjs';

const executable = browserExecutable();
const skip = executable ? false : 'Chromium-based browser is not available';

const INSTALLER_HELPERS = `
(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/GitFreeb/sidepad-extension/releases/latest') {
      return Promise.resolve(new Response(JSON.stringify({
        tag_name: 'v1.7.10.2', draft: false, prerelease: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return nativeFetch(input, init);
  };
})();
`;

let browser;
let page;

before(async () => {
  if (skip) return;
  browser = await Browser.launch({ executable });
  page = await browser.open(browser.extensionUrl('installer.html'), { beforeLoad: INSTALLER_HELPERS });
  await page.evaluate(`chrome.storage.local.set({ lang: 'ru', lightMode: true })`);
  const loaded = new Promise((resolve) => {
    const off = page.on('Page.loadEventFired', () => { off(); resolve(); });
  });
  await page.send('Page.reload');
  await loaded;
  await page.waitFor(`document.getElementById('latestVersion').textContent === 'v1.7.10.2'`);
});

after(async () => {
  if (browser) await browser.close();
});

test('installer shows the release, stored theme and explicit folder step', { skip }, async () => {
  const view = await page.evaluate(`({
    title: document.getElementById('pageTitle').textContent,
    current: document.getElementById('currentVersion').textContent,
    latest: document.getElementById('latestVersion').textContent,
    folder: document.getElementById('folderName').textContent,
    status: document.getElementById('status').textContent,
    theme: document.documentElement.dataset.theme,
    installLabel: document.getElementById('installButton').textContent,
    steps: [...document.querySelectorAll('.steps li')].map((item) => item.textContent.trim()),
  })`);
  assert.deepEqual(view, {
    title: 'Обновление Sidepad',
    current: 'v1.7.10.1',
    latest: 'v1.7.10.2',
    folder: 'не выбрана',
    status: 'Версия v1.7.10.2 готова к установке.',
    theme: 'light',
    installLabel: 'Установить v1.7.10.2',
    steps: ['Проверить папку', 'Загрузить файлы релиза', 'Проверить пакет', 'Установить и перезапустить'],
  });
});

test('installer remains usable at a narrow viewport and switches language', { skip }, async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
  assert.equal(await page.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
  await page.evaluate(`document.getElementById('langButton').click()`);
  await page.waitFor(`document.getElementById('pageTitle').textContent === 'Update Sidepad'`);
  assert.equal(await page.evaluate(`document.getElementById('installButton').textContent`), 'Install v1.7.10.2');
});
