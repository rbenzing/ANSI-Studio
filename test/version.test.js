// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('package.json, package-lock.json and the changelog agree on one semantic version', () => {
  const { version } = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([lock.version, lock.packages[''].version], [version, version], 'change the version with npm version, which updates both files');
  const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  assert.match(read('CHANGELOG.md'), heading, `CHANGELOG.md needs a "## [${version}] - YYYY-MM-DD" section`);
});
