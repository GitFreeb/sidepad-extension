// Минимальный CDP-харнесс без npm-зависимостей: браузер запускается во
// временном профиле с --remote-debugging-pipe, расширение грузится через
// Extensions.loadUnpacked (Chrome stable больше не принимает --load-extension).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function playwrightChromium() {
  const cache = path.join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return null;
  const builds = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const exe = path.join(cache, build, arch,
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

export function browserExecutable() {
  const configured = process.env.SIDEPAD_BROWSER;
  if (configured) return existsSync(configured) ? configured : null;
  return playwrightChromium();
}

class CdpSession {
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  on(method, listener) {
    return this.browser.onEvent(method, listener, this.sessionId);
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`evaluate failed: ${description}`);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeout = 5000, interval = 50 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression).catch((error) => error);
      if (last && !(last instanceof Error)) return last;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`waitFor timed out: ${expression} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
  }
}

export class Browser {
  static async launch({ executable = browserExecutable(), args = [], headless = true, extension = EXTENSION_ROOT } = {}) {
    if (!executable) throw new Error('No Chromium-based browser found.');
    const userDataDir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'sidepad-profile-'));
    const child = spawn(executable, [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      ...(headless ? ['--headless=new'] : []),
      ...args,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    child.stdio[2].resume();
    const browser = new Browser(child, userDataDir);
    await browser.send('Target.setDiscoverTargets', { discover: true });
    if (extension) {
      const loaded = await browser.send('Extensions.loadUnpacked', { path: extension });
      browser.extensionId = loaded.id;
    }
    return browser;
  }

  constructor(child, userDataDir) {
    this.child = child;
    this.userDataDir = userDataDir;
    this.extensionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = '';
    this.closed = false;
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (chunk) => this.receive(chunk));
    child.on('exit', () => {
      this.closed = true;
      this.pending.forEach(({ reject }) => reject(new Error('browser exited')));
      this.pending.clear();
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, method } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result || {});
      } else if (message.method) {
        this.listeners.forEach((entry) => {
          if (entry.method === message.method && (entry.sessionId === undefined || entry.sessionId === message.sessionId)) {
            entry.listener(message.params, message.sessionId);
          }
        });
      }
    }
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error('browser closed'));
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.child.stdio[3].write(`${JSON.stringify(message)}\0`);
    });
  }

  onEvent(method, listener, sessionId = undefined) {
    const entry = { method, listener, sessionId };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  extensionUrl(file) {
    return `chrome-extension://${this.extensionId}/${file}`;
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const session = new CdpSession(this, sessionId);
    await session.send('Runtime.enable');
    return session;
  }

  async open(url, { beforeLoad = null } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const session = await this.attach(targetId);
    session.targetId = targetId;
    await session.send('Page.enable');
    await session.send('Network.enable');
    if (beforeLoad) {
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoad });
    }
    const loaded = new Promise((resolve) => {
      const off = session.on('Page.loadEventFired', () => { off(); resolve(); });
    });
    await session.send('Page.navigate', { url });
    await loaded;
    return session;
  }

  async closeTarget(session) {
    await this.send('Target.closeTarget', { targetId: session.targetId }).catch(() => {});
  }

  async serviceWorker() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { targetInfos } = await this.send('Target.getTargets');
      const worker = targetInfos.find((info) => info.type === 'service_worker'
        && info.url === this.extensionUrl('background.js'));
      if (worker) {
        const session = await this.attach(worker.targetId);
        await session.send('Network.enable').catch(() => {});
        return session;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('extension service worker not found');
  }

  async close() {
    if (!this.closed) {
      await this.send('Browser.close').catch(() => {});
      await new Promise((resolve) => {
        if (this.closed) resolve();
        else this.child.once('exit', resolve);
        setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 3000);
      });
    }
    rmSync(this.userDataDir, { recursive: true, force: true });
  }
}

// Сетевой журнал страницы/воркера: фиксирует каждый исходящий URL, чтобы тесты
// могли доказать отсутствие запросов к Notes API.
export function recordRequests(session) {
  const urls = [];
  session.on('Network.requestWillBeSent', (params) => urls.push(params.request.url));
  return urls;
}
