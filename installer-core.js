const REPOSITORY = 'GitFreeb/sidepad-extension';

export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${REPOSITORY}/releases/latest`;
export const PACKAGE_DESCRIPTOR = 'sidepad-package.json';
export const MAX_PACKAGE_FILES = 80;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;

const REQUIRED_FILES = [
  PACKAGE_DESCRIPTOR,
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'installer.html',
  'installer.css',
  'installer.js',
  'installer-core.js',
];

export class InstallerError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InstallerError';
    this.code = code;
  }
}

export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function versionFromTag(tag) {
  const match = String(tag || '').match(/^v(\d+(?:\.\d+){1,3})$/);
  if (!match) throw new InstallerError('invalid-release', 'The latest release tag is not a Sidepad version.');
  const parts = match[1].split('.').map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535)) {
    throw new InstallerError('invalid-release', 'The latest release version is outside Chrome limits.');
  }
  return match[1];
}

export function validatePackagePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 180 || path.includes('\\')) {
    throw new InstallerError('invalid-package', 'The update contains an invalid file path.');
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._+@()-]+$/.test(part))) {
    throw new InstallerError('invalid-package', 'The update contains an unsafe file path.');
  }
  return path;
}

export function validatePackageDescriptor(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw new InstallerError('invalid-package', 'The update package descriptor is not supported.');
  }
  if (value.files.length === 0 || value.files.length > MAX_PACKAGE_FILES) {
    throw new InstallerError('invalid-package', 'The update package contains an unexpected number of files.');
  }
  const files = value.files.map(validatePackagePath);
  if (new Set(files).size !== files.length) {
    throw new InstallerError('invalid-package', 'The update package contains duplicate paths.');
  }
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) {
      throw new InstallerError('invalid-package', `The update package is missing ${required}.`);
    }
  }
  return { schemaVersion: 1, files };
}

export function validateExtensionManifest(value, expectedVersion) {
  if (!value || value.manifest_version !== 3 || value.name !== 'Sidepad' || value.version !== expectedVersion) {
    throw new InstallerError('invalid-package', 'The release manifest does not match the selected Sidepad version.');
  }
  return value;
}

export function rawFileUrl(tag, path) {
  const safeTag = `v${versionFromTag(tag)}`;
  const safePath = validatePackagePath(path).split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${REPOSITORY}/${encodeURIComponent(safeTag)}/${safePath}`;
}

async function fetchBytes(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit' });
  } catch (error) {
    throw new InstallerError('network', 'Sidepad could not reach GitHub.', error);
  }
  if (!response.ok) {
    throw new InstallerError('network', `GitHub returned HTTP ${response.status}.`);
  }
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_FILE_BYTES) {
    throw new InstallerError('invalid-package', 'An update file is unexpectedly large.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new InstallerError('invalid-package', 'An update file is unexpectedly large.');
  }
  return bytes;
}

function parseJsonBytes(bytes, code) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new InstallerError(code, 'GitHub returned malformed update metadata.', error);
  }
}

export async function fetchLatestRelease(fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(LATEST_RELEASE_URL, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' },
    });
  } catch (error) {
    throw new InstallerError('network', 'Sidepad could not check the latest GitHub release.', error);
  }
  if (!response.ok) {
    throw new InstallerError('network', `GitHub returned HTTP ${response.status}.`);
  }
  const release = await response.json();
  if (release.draft || release.prerelease) {
    throw new InstallerError('invalid-release', 'GitHub did not return a stable Sidepad release.');
  }
  return { tag: `v${versionFromTag(release.tag_name)}`, version: versionFromTag(release.tag_name) };
}

export async function fetchReleasePackage({ fetchImpl = fetch, tag, onProgress = () => {} }) {
  const version = versionFromTag(tag);
  const descriptorBytes = await fetchBytes(fetchImpl, rawFileUrl(tag, PACKAGE_DESCRIPTOR));
  const descriptor = validatePackageDescriptor(parseJsonBytes(descriptorBytes, 'invalid-package'));
  const files = new Map([[PACKAGE_DESCRIPTOR, descriptorBytes]]);
  let totalBytes = descriptorBytes.byteLength;
  let completed = 1;
  onProgress({ completed, total: descriptor.files.length, path: PACKAGE_DESCRIPTOR });

  const remaining = descriptor.files.filter((path) => path !== PACKAGE_DESCRIPTOR);
  for (let offset = 0; offset < remaining.length; offset += 6) {
    const batch = remaining.slice(offset, offset + 6);
    const loaded = await Promise.all(batch.map(async (path) => [path, await fetchBytes(fetchImpl, rawFileUrl(tag, path))]));
    for (const [path, bytes] of loaded) {
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new InstallerError('invalid-package', 'The update package is unexpectedly large.');
      }
      files.set(path, bytes);
      completed += 1;
      onProgress({ completed, total: descriptor.files.length, path });
    }
  }

  const manifest = validateExtensionManifest(parseJsonBytes(files.get('manifest.json'), 'invalid-package'), version);
  return { version, descriptor, manifest, files };
}

export function installationOrder(files) {
  const paths = [...files];
  return paths
    .filter((path) => path !== PACKAGE_DESCRIPTOR && path !== 'manifest.json')
    .concat(PACKAGE_DESCRIPTOR, 'manifest.json');
}

export async function applyPackageUpdate({
  update,
  previousDescriptor = null,
  readFile,
  writeFile,
  removeFile,
  onCleanupError = () => {},
}) {
  const backups = new Map();
  const written = [];
  try {
    for (const path of installationOrder(update.descriptor.files)) {
      backups.set(path, await readFile(path));
      await writeFile(path, update.files.get(path));
      written.push(path);
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const path of written.reverse()) {
      try {
        const previous = backups.get(path);
        if (previous === null) await removeFile(path);
        else await writeFile(path, previous);
      } catch (_) {
        rollbackFailed = true;
      }
    }
    throw new InstallerError(
      rollbackFailed ? 'rollback' : 'write',
      rollbackFailed ? 'The update failed and rollback was incomplete.' : 'The update could not be written.',
      error,
    );
  }

  if (previousDescriptor) {
    const nextFiles = new Set(update.descriptor.files);
    for (const obsolete of previousDescriptor.files.filter((path) => !nextFiles.has(path))) {
      try { await removeFile(obsolete); } catch (error) { onCleanupError(obsolete, error); }
    }
  }
}
