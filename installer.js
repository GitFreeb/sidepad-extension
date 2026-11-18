import {
  InstallerError,
  PACKAGE_DESCRIPTOR,
  RELEASES_PAGE_URL,
  applyPackageUpdate,
  compareVersions,
  fetchLatestRelease,
  fetchReleasePackage,
  validatePackageDescriptor,
} from './installer-core.js';

const DB_NAME = 'sidepad-installer';
const DB_STORE = 'settings';
const DIRECTORY_KEY = 'installDirectory';
const REQUIRED_LOCAL_FILES = ['manifest.json', 'installer.html', 'installer.js', 'installer-core.js'];

const COPY = {
  ru: {
    title: 'Обновление Sidepad',
    lead: 'Новая версия устанавливается прямо в папку распакованного расширения.',
    current: 'Сейчас',
    latest: 'Релиз',
    checking: 'проверяем…',
    folder: 'Папка установки',
    folderMissing: 'не выбрана',
    choose: 'Выбрать',
    change: 'Сменить',
    stepFolder: 'Проверить папку',
    stepDownload: 'Загрузить файлы релиза',
    stepVerify: 'Проверить пакет',
    stepInstall: 'Установить и перезапустить',
    checkingRelease: 'Проверяем последний релиз…',
    chooseHint: 'Выберите папку sidepad-installed. Sidepad запомнит её для следующих обновлений.',
    ready: 'Версия {version} готова к установке.',
    upToDate: 'Установлена последняя версия Sidepad.',
    currentAhead: 'Установленная версия новее последнего опубликованного релиза.',
    install: 'Установить {version}',
    installing: 'Устанавливаем…',
    openRelease: 'Открыть релиз на GitHub',
    folderReady: 'Папка {name} подтверждена.',
    downloading: 'Загружено файлов: {done} из {total}.',
    verifying: 'Проверяем версию и состав пакета…',
    writing: 'Записываем файлы. Не закрывайте эту вкладку.',
    restarting: 'Версия {version} установлена. Sidepad перезапускается…',
    unsupported: 'Этот браузер не даёт Sidepad доступ к папке. Включите File System Access API или используйте Chrome.',
    errorNetwork: 'Не удалось получить релиз с GitHub. Проверьте интернет и повторите попытку.',
    errorFolder: 'Выбрана не установленная копия Sidepad. Укажите папку sidepad-installed, загруженную в chrome://extensions.',
    errorPermission: 'Chrome не дал доступ на запись. Снова выберите папку и разрешите изменение файлов.',
    errorPackage: 'Релиз не прошёл проверку. Установка остановлена без изменения текущей версии.',
    errorWrite: 'Не удалось записать обновление. Sidepad восстановил прежние файлы.',
    errorRollback: 'Запись прервалась, и часть прежних файлов не удалось восстановить. Переустановите Sidepad из последнего GitHub Release.',
    errorGeneric: 'Обновление не завершено. Текущая версия не изменена.',
  },
  en: {
    title: 'Update Sidepad',
    lead: 'The new version is installed directly into the unpacked extension folder.',
    current: 'Current',
    latest: 'Release',
    checking: 'checking…',
    folder: 'Install folder',
    folderMissing: 'not selected',
    choose: 'Choose',
    change: 'Change',
    stepFolder: 'Verify the folder',
    stepDownload: 'Download release files',
    stepVerify: 'Verify the package',
    stepInstall: 'Install and restart',
    checkingRelease: 'Checking the latest release…',
    chooseHint: 'Choose the sidepad-installed folder. Sidepad will remember it for future updates.',
    ready: 'Version {version} is ready to install.',
    upToDate: 'The latest Sidepad version is installed.',
    currentAhead: 'The installed version is newer than the latest published release.',
    install: 'Install {version}',
    installing: 'Installing…',
    openRelease: 'Open the GitHub release',
    folderReady: 'Folder {name} is linked.',
    downloading: 'Downloaded {done} of {total} files.',
    verifying: 'Checking the package version and contents…',
    writing: 'Writing files. Keep this tab open.',
    restarting: 'Version {version} is installed. Sidepad is restarting…',
    unsupported: 'This browser does not give Sidepad folder access. Enable the File System Access API or use Chrome.',
    errorNetwork: 'Sidepad could not load the GitHub release. Check your connection and try again.',
    errorFolder: 'This is not the installed Sidepad copy. Choose the sidepad-installed folder loaded in chrome://extensions.',
    errorPermission: 'Chrome did not grant write access. Choose the folder again and allow file changes.',
    errorPackage: 'The release failed verification. Installation stopped without changing the current version.',
    errorWrite: 'Sidepad could not write the update and restored the previous files.',
    errorRollback: 'Writing stopped and some previous files could not be restored. Reinstall Sidepad from the latest GitHub Release.',
    errorGeneric: 'The update did not finish. The current version was not changed.',
  },
};

const state = {
  lang: 'en',
  currentVersion: chrome.runtime.getManifest().version,
  latestRelease: null,
  directory: null,
  directoryReady: false,
  busy: false,
};

const element = (id) => document.getElementById(id);
const text = (key, values = {}) => Object.entries(values).reduce(
  (result, [name, value]) => result.replace(`{${name}}`, value),
  COPY[state.lang][key] || key,
);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSetting(key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readonly');
    const request = transaction.objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeSetting(key, value) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readwrite');
    transaction.objectStore(DB_STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function setStatus(message, kind = '') {
  const status = element('status');
  status.textContent = message;
  status.className = `status${kind ? ` ${kind}` : ''}`;
}

function setStep(name, status) {
  const item = document.querySelector(`[data-step="${name}"]`);
  item.classList.remove('active', 'done', 'error');
  if (status) item.classList.add(status);
}

function resetSteps() {
  for (const name of ['folder', 'download', 'verify', 'install']) setStep(name, '');
}

function applyCopy() {
  document.documentElement.lang = state.lang;
  document.title = `Sidepad — ${text('title')}`;
  element('pageTitle').textContent = text('title');
  element('pageLead').textContent = text('lead');
  element('currentLabel').textContent = text('current');
  element('latestLabel').textContent = text('latest');
  element('folderLabel').textContent = text('folder');
  element('folderButton').textContent = state.directoryReady ? text('change') : text('choose');
  element('stepFolder').textContent = text('stepFolder');
  element('stepDownload').textContent = text('stepDownload');
  element('stepVerify').textContent = text('stepVerify');
  element('stepInstall').textContent = text('stepInstall');
  element('releaseLink').textContent = text('openRelease');
  element('langButton').textContent = state.lang === 'ru' ? 'RU' : 'EN';
  renderState();
}

function renderState() {
  element('currentVersion').textContent = `v${state.currentVersion}`;
  element('latestVersion').textContent = state.latestRelease ? `v${state.latestRelease.version}` : text('checking');
  element('folderName').textContent = state.directoryReady ? state.directory.name : text('folderMissing');
  element('folderButton').textContent = state.directoryReady ? text('change') : text('choose');

  const installButton = element('installButton');
  if (state.busy) {
    installButton.textContent = text('installing');
    installButton.disabled = true;
    element('folderButton').disabled = true;
    return;
  }
  element('folderButton').disabled = !window.showDirectoryPicker;
  const comparison = state.latestRelease ? compareVersions(state.latestRelease.version, state.currentVersion) : 0;
  installButton.textContent = state.latestRelease ? text('install', { version: `v${state.latestRelease.version}` }) : text('install', { version: '' });
  installButton.disabled = !window.showDirectoryPicker || !state.latestRelease || comparison <= 0;
}

async function permission(handle, request) {
  const options = { mode: 'readwrite' };
  let result = await handle.queryPermission(options);
  if (result !== 'granted' && request) result = await handle.requestPermission(options);
  return result;
}

async function parentDirectory(root, path, create = false) {
  const parts = path.split('/');
  const name = parts.pop();
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}

async function readFile(root, path) {
  const { directory, name } = await parentDirectory(root, path);
  const handle = await directory.getFileHandle(name);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function readFileIfPresent(root, path) {
  try {
    return await readFile(root, path);
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}

async function writeFile(root, path, bytes) {
  const { directory, name } = await parentDirectory(root, path, true);
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch (_) { /* stream may already be closed */ }
    throw error;
  }
}

async function removeFileIfPresent(root, path) {
  try {
    const { directory, name } = await parentDirectory(root, path);
    await directory.removeEntry(name);
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function validateDirectory(handle) {
  let selectedManifest;
  try {
    selectedManifest = JSON.parse(new TextDecoder().decode(await readFile(handle, 'manifest.json')));
  } catch (error) {
    throw new InstallerError('folder', 'The selected folder has no readable Sidepad manifest.', error);
  }
  if (selectedManifest.name !== 'Sidepad' || selectedManifest.version !== state.currentVersion) {
    throw new InstallerError('folder', 'The selected folder is not the running Sidepad version.');
  }
  for (const path of REQUIRED_LOCAL_FILES) {
    const selected = await readFileIfPresent(handle, path);
    const runningResponse = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    const running = runningResponse.ok ? new Uint8Array(await runningResponse.arrayBuffer()) : null;
    if (!selected || !running || !bytesEqual(selected, running)) {
      throw new InstallerError('folder', 'The selected folder is another Sidepad copy.');
    }
  }
  return true;
}

async function chooseDirectory() {
  if (!window.showDirectoryPicker) throw new InstallerError('unsupported', 'File System Access is unavailable.');
  const handle = await window.showDirectoryPicker({ id: 'sidepad-install-directory', mode: 'readwrite' });
  if (await permission(handle, true) !== 'granted') throw new InstallerError('permission', 'Write permission was not granted.');
  await validateDirectory(handle);
  await writeSetting(DIRECTORY_KEY, handle);
  state.directory = handle;
  state.directoryReady = true;
  setStep('folder', 'done');
  setStatus(text('folderReady', { name: handle.name }));
  renderState();
  return handle;
}

async function ensureDirectory() {
  if (!state.directory) return chooseDirectory();
  if (await permission(state.directory, true) !== 'granted') throw new InstallerError('permission', 'Write permission was not granted.');
  await validateDirectory(state.directory);
  state.directoryReady = true;
  setStep('folder', 'done');
  renderState();
  return state.directory;
}

async function currentPackageDescriptor(root) {
  const bytes = await readFileIfPresent(root, PACKAGE_DESCRIPTOR);
  if (!bytes) return null;
  try {
    return validatePackageDescriptor(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (_) {
    return null;
  }
}

async function installPackage(root, update) {
  const previousDescriptor = await currentPackageDescriptor(root);
  await applyPackageUpdate({
    update,
    previousDescriptor,
    readFile: (path) => readFileIfPresent(root, path),
    writeFile: (path, bytes) => writeFile(root, path, bytes),
    removeFile: (path) => removeFileIfPresent(root, path),
    onCleanupError: (path, error) => console.warn(`Sidepad could not remove obsolete ${path}`, error),
  });
}

function friendlyError(error) {
  if (error?.name === 'AbortError') return null;
  if (error?.code === 'network') return text('errorNetwork');
  if (error?.code === 'folder') return text('errorFolder');
  if (error?.code === 'permission') return text('errorPermission');
  if (error?.code === 'invalid-package' || error?.code === 'invalid-release') return text('errorPackage');
  if (error?.code === 'write') return text('errorWrite');
  if (error?.code === 'rollback') return text('errorRollback');
  if (error?.code === 'unsupported') return text('unsupported');
  return text('errorGeneric');
}

async function refreshLatestRelease() {
  try {
    state.latestRelease = await fetchLatestRelease();
    const comparison = compareVersions(state.latestRelease.version, state.currentVersion);
    if (comparison > 0) setStatus(text('ready', { version: `v${state.latestRelease.version}` }));
    else if (comparison === 0) setStatus(text('upToDate'), 'success');
    else setStatus(text('currentAhead'));
  } catch (error) {
    console.error(error);
    setStatus(friendlyError(error), 'error');
  }
  renderState();
}

async function runInstall() {
  if (state.busy || !state.latestRelease) return;
  state.busy = true;
  resetSteps();
  renderState();
  try {
    setStep('folder', 'active');
    const directory = await ensureDirectory();
    setStep('folder', 'done');

    setStep('download', 'active');
    const update = await fetchReleasePackage({
      tag: state.latestRelease.tag,
      onProgress: ({ completed, total }) => setStatus(text('downloading', { done: completed, total })),
    });
    setStep('download', 'done');
    setStep('verify', 'active');
    setStatus(text('verifying'));
    if (update.version !== state.latestRelease.version) throw new InstallerError('invalid-package', 'Release versions disagree.');
    setStep('verify', 'done');

    setStep('install', 'active');
    setStatus(text('writing'));
    await installPackage(directory, update);
    setStep('install', 'done');
    setStatus(text('restarting', { version: `v${update.version}` }), 'success');
    await chrome.storage.local.set({
      updateInfo: { lastChecked: Date.now(), latestVersion: update.version, dismissedVersion: '' },
    });
    setTimeout(() => chrome.runtime.reload(), 1600);
  } catch (error) {
    console.error(error);
    const message = friendlyError(error);
    if (!message) {
      state.busy = false;
      renderState();
      return;
    }
    const active = document.querySelector('.steps li.active');
    if (active) active.classList.replace('active', 'error');
    setStatus(message, 'error');
    state.busy = false;
    renderState();
  }
}

async function restoreDirectory() {
  try {
    const handle = await readSetting(DIRECTORY_KEY);
    if (!handle || await permission(handle, false) !== 'granted') return;
    await validateDirectory(handle);
    state.directory = handle;
    state.directoryReady = true;
    setStep('folder', 'done');
  } catch (error) {
    console.warn('Sidepad could not restore the install folder', error);
  }
}

element('releaseLink').href = RELEASES_PAGE_URL;
element('installButton').addEventListener('click', runInstall);
element('folderButton').addEventListener('click', async () => {
  try { await chooseDirectory(); } catch (error) {
    const message = friendlyError(error);
    if (message) setStatus(message, 'error');
  }
});
element('langButton').addEventListener('click', async () => {
  state.lang = state.lang === 'ru' ? 'en' : 'ru';
  await chrome.storage.local.set({ lang: state.lang });
  applyCopy();
});

const settings = await chrome.storage.local.get(['lang', 'lightMode']);
state.lang = settings.lang === 'ru' ? 'ru' : 'en';
if (settings.lightMode) document.documentElement.dataset.theme = 'light';
applyCopy();
if (!window.showDirectoryPicker) setStatus(text('unsupported'), 'error');
else {
  await restoreDirectory();
  applyCopy();
  if (!state.directoryReady) setStatus(text('chooseHint'));
  await refreshLatestRelease();
}
