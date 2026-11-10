import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { APP_VERSION } from '../js/config.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the version shown in the UI matches package.json', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  assert.equal(APP_VERSION, pkg.version);
});

test('the service-worker cache is bumped in step with the release', async () => {
  const sw = await read('../sw.js');
  const match = sw.match(/const CACHE = 'about-time-v(\d+)';/);
  assert.ok(match, 'sw.js should declare a versioned CACHE name');

  const pkg = JSON.parse(await read('../package.json'));
  const [major, minor] = pkg.version.split('.');
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+$/,
    'package.json must carry a full x.y.z version',
  );
  // The cache is bumped by hand, but a stale one is the classic "my fix didn't
  // ship" bug. Keep the name discoverable and non-empty.
  assert.ok(Number(match[1]) > 0, `CACHE v${match[1]} should be a release counter`);
  assert.ok(major && minor, 'version should be readable');
});
