// Phase 0 / item 6: package.json is the single source of the version string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('CLI help shows the version from package.json', () => {
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/index.ts'), '--help'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0);
  assert.match(res.stdout, new RegExp(`\\(v${pkg.version.replace(/\./g, '\\.')}\\)`));
});

test('no other hard-coded copy of the version exists in src/', () => {
  const offenders: string[] = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    if (/\bv?\d+\.\d+\.\d+\b/.test(text.replace(/\$\{pkg\.version\}/g, ''))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test('package.json has the repository field npm provenance verifies', () => {
  assert.match(pkg.repository?.url ?? '', /github\.com\/queryguardhq\/queryguard/);
});
