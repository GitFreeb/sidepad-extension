import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  InstallerError,
  LATEST_RELEASE_URL,
  PACKAGE_DESCRIPTOR,
  applyPackageUpdate,
  fetchLatestRelease,
  fetchReleasePackage,
  installationOrder,
  rawFileUrl,
  validatePackageDescriptor,
  validatePackagePath,
  versionFromTag,
} from '../installer-core.js';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root));

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

test('release tags are strict Chrome-compatible versions', () => {
  assert.equal(versionFromTag('v1.7.10.1'), '1.7.10.1');
  assert.equal(versionFromTag('v1.7.10'), '1.7.10');
  for (const value of ['1.7.10.1', 'latest', 'v1', 'v1.2.3.4.5', 'v1.2.-1', 'v65536.1']) {
    assert.throws(() => versionFromTag(value), InstallerError, value);
  }
});

test('package paths cannot escape the selected install directory', () => {
  assert.equal(validatePackagePath('icons/icon128.png'), 'icons/icon128.png');
  for (const path of ['../manifest.json', '/manifest.json', 'icons//x.png', 'icons/./x.png', 'icons\\x.png', 'a b.js']) {
    assert.throws(() => validatePackagePath(path), (error) => error.code === 'invalid-package', path);
  }
});

test('package descriptor rejects duplicates and missing runtime files', async () => {
  const descriptor = JSON.parse(await read(PACKAGE_DESCRIPTOR));
  assert.deepEqual(validatePackageDescriptor(descriptor), descriptor);
  assert.throws(
    () => validatePackageDescriptor({ ...descriptor, files: descriptor.files.concat('popup.js') }),
    (error) => error.code === 'invalid-package',
  );
  assert.throws(
    () => validatePackageDescriptor({ ...descriptor, files: descriptor.files.filter((path) => path !== 'manifest.json') }),
    (error) => error.code === 'invalid-package',
  );
});

test('package lists every local runtime dependency', async () => {
  const descriptor = JSON.parse(await read(PACKAGE_DESCRIPTOR));
  const packaged = new Set(descriptor.files);
  const manifest = JSON.parse(await read('manifest.json'));
  const required = new Set([
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]);

  for (const path of descriptor.files.filter((name) => /\.(?:html|js)$/.test(name))) {
    const source = (await read(path)).toString('utf8');
    for (const match of source.matchAll(/(?:src=|href=|from\s+)["']\.\/?([^"']+\.(?:js|css))["']/g)) required.add(match[1]);
  }
  for (const path of required) assert.ok(packaged.has(path), `${path} must be in ${PACKAGE_DESCRIPTOR}`);
});

test('latest release ignores drafts and normalizes the release tag', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return response(JSON.stringify({ tag_name: 'v2.4.1', draft: false, prerelease: false }), 200, {
      'content-type': 'application/json',
    });
  };
  assert.deepEqual(await fetchLatestRelease(fetchImpl), { tag: 'v2.4.1', version: '2.4.1' });
  assert.deepEqual(calls, [LATEST_RELEASE_URL]);
});

test('release package is fully downloaded from the immutable tag and manifest is installed last', async () => {
  const descriptor = JSON.parse(await read(PACKAGE_DESCRIPTOR));
  const version = JSON.parse(await read('manifest.json')).version;
  const tag = `v${version}`;
  const bodies = new Map();
  for (const path of descriptor.files) bodies.set(rawFileUrl(tag, path), await read(path));
  const calls = [];
  const progress = [];
  const update = await fetchReleasePackage({
    tag,
    fetchImpl: async (url) => {
      calls.push(url);
      return bodies.has(url) ? response(bodies.get(url)) : response('missing', 404);
    },
    onProgress: (value) => progress.push(value),
  });

  assert.equal(update.version, version);
  assert.equal(update.files.size, descriptor.files.length);
  assert.equal(calls.length, descriptor.files.length);
  assert.equal(progress.at(-1).completed, descriptor.files.length);
  assert.deepEqual(installationOrder(descriptor.files).slice(-2), [PACKAGE_DESCRIPTOR, 'manifest.json']);
});

test('failed writes restore old files and remove files created by the interrupted update', async () => {
  const encoder = new TextEncoder();
  const old = (value) => encoder.encode(`old:${value}`);
  const next = (value) => encoder.encode(`next:${value}`);
  const disk = new Map([
    ['a.js', old('a')],
    [PACKAGE_DESCRIPTOR, old('descriptor')],
    ['manifest.json', old('manifest')],
  ]);
  const update = {
    descriptor: { files: ['new.js', 'a.js', PACKAGE_DESCRIPTOR, 'manifest.json'] },
    files: new Map([
      ['new.js', next('new')],
      ['a.js', next('a')],
      [PACKAGE_DESCRIPTOR, next('descriptor')],
      ['manifest.json', next('manifest')],
    ]),
  };

  await assert.rejects(applyPackageUpdate({
    update,
    readFile: async (path) => disk.get(path) || null,
    writeFile: async (path, bytes) => {
      if (path === 'manifest.json' && bytes === update.files.get(path)) throw new Error('disk full');
      disk.set(path, bytes);
    },
    removeFile: async (path) => disk.delete(path),
  }), (error) => error.code === 'write');

  assert.equal(disk.has('new.js'), false);
  assert.deepEqual(disk.get('a.js'), old('a'));
  assert.deepEqual(disk.get(PACKAGE_DESCRIPTOR), old('descriptor'));
  assert.deepEqual(disk.get('manifest.json'), old('manifest'));
});

test('successful install removes only files declared obsolete by the previous package', async () => {
  const bytes = new TextEncoder().encode('next');
  const disk = new Map([
    ['kept-by-user.txt', new Uint8Array([1])],
    ['obsolete.js', new Uint8Array([2])],
  ]);
  const files = ['a.js', PACKAGE_DESCRIPTOR, 'manifest.json'];
  await applyPackageUpdate({
    update: { descriptor: { files }, files: new Map(files.map((path) => [path, bytes])) },
    previousDescriptor: { files: ['obsolete.js', ...files] },
    readFile: async (path) => disk.get(path) || null,
    writeFile: async (path, value) => disk.set(path, value),
    removeFile: async (path) => disk.delete(path),
  });

  assert.equal(disk.has('obsolete.js'), false);
  assert.equal(disk.has('kept-by-user.txt'), true);
  for (const path of files) assert.equal(disk.get(path), bytes);
});
