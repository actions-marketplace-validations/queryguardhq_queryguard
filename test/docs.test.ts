// Phase 0 / item 7: keep the docs honest. These checks guard against claims creeping back
// and against code/documentation drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('no "blast-radius" claims in shipped docs, metadata or user-facing text', () => {
  for (const f of ['README.md', 'AGENTS.md', 'package.json', 'action.yml', 'index.html']) {
    assert.doesNotMatch(read(f), /blast.?radius/i, f);
  }
  // The comment marker keeps its legacy name on purpose; nothing else in src/ may use the phrase.
  const offenders = fs
    .readdirSync(path.join(ROOT, 'src'))
    .flatMap((f) => read(`src/${f}`).split('\n').filter((l) => /blast.?radius/i.test(l) && !l.includes('BOT_MARKER')));
  assert.deepEqual(offenders, []);
});

test('index.html hard-codes no version and no unmeasured latency or cost claims', () => {
  const page = read('index.html');
  assert.doesNotMatch(page, /\bv\d+\.\d+\.\d+\b/);
  assert.doesNotMatch(page, /<\s*20\s*milliseconds|Cost: \d/);
  assert.match(page, /GitHub API/); // privacy text matches the README
});

test('README documents every status and exit code', () => {
  const readme = read('README.md');
  for (const word of ['PASS', 'FAIL', 'INCONCLUSIVE']) assert.match(readme, new RegExp(`\\*\\*${word}\\*\\*`));
  assert.match(readme, /`0` PASS, `1` FAIL, `2` INCONCLUSIVE/);
});

test('README documents every action.yml input', () => {
  const readme = read('README.md');
  const inputs = read('action.yml').split(/^inputs:\n/m)[1].split(/^runs:/m)[0].match(/^  ([a-z0-9-]+):/gm)!;
  assert.ok(inputs.length >= 12);
  for (const raw of inputs) {
    const name = raw.trim().slice(0, -1);
    assert.ok(readme.includes(`| \`${name}\` |`), `README table is missing input '${name}'`);
  }
});

test('AGENTS.md and the README template make CONCURRENTLY conditional on transactions', () => {
  for (const f of ['AGENTS.md', 'README.md']) {
    const text = read(f);
    assert.match(text, /only if the migration does not run inside a transaction/i, f);
    assert.match(text, /disable_ddl_transaction!/, f);
    assert.match(text, /atomic = False/, f);
  }
  assert.doesNotMatch(read('AGENTS.md'), /Never generate CREATE INDEX on existing tables without CONCURRENTLY/);
});

test('README makes no unmeasured latency or production-safety claims', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /<\s*20\s*ms|~\s*8\s*s\b/);
  assert.doesNotMatch(readme, /RDS|Aurora/);
  // A provenance badge is only honest while releases are actually published with provenance.
  if (/provenance/i.test(readme)) {
    assert.match(read('.github/workflows/release.yml'), /npm publish --provenance/);
  }
  assert.match(readme, /not evidence of production safety/i);
});
