// Phase 0 / item 7: keep the docs honest. These checks guard against claims creeping back
// and against code/documentation drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { shapeFunctionSql } from './snapshot-harness';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/** Every file under src/, as a path relative to src/. */
const sourceFiles = () =>
  (fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) =>
    fs.statSync(path.join(ROOT, 'src', f)).isFile()
  );

test('no "blast-radius" claims in shipped docs, metadata or user-facing text', () => {
  for (const f of ['README.md', 'AGENTS.md', 'package.json', 'action.yml', 'index.html']) {
    assert.doesNotMatch(read(f), /blast.?radius/i, f);
  }
  // The comment marker keeps its legacy name on purpose; nothing else in src/ may use the phrase.
  const offenders = sourceFiles()
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

// Phase 1 / item 8: snapshot docs stay true to the code and to the trust boundary.
test('README and the security guide say the PR check never receives production credentials', () => {
  assert.match(read('README.md'), /\*\*The PR check never receives production credentials\.\*\*/);
  assert.match(read('docs/snapshot-security.md'), /Holds production credentials \| Yes: a dedicated read-only role \(below\) \| \*\*Never\.\*\*/);
  assert.match(read('docs/examples/snapshot-refresh.yml'), /The QueryGuard PR check never receives them/);
});

test('the documented shape function and grants are the ones the tests run', () => {
  const doc = read('docs/snapshot-security.md').replace(/\s+/g, ' ');
  for (const sql of shapeFunctionSql('queryguard_snapshot')) {
    assert.ok(doc.includes(`${sql.replace(/\s+/g, ' ')};`), `docs/snapshot-security.md is missing: ${sql.slice(0, 60)}`);
  }
});

test('the example refresh workflow only runs on a schedule or by hand, with secrets in an environment', () => {
  const wf = read('docs/examples/snapshot-refresh.yml');
  const on = wf.split(/^on:\n/m)[1].split(/^\S/m)[0];
  assert.deepEqual(on.match(/^  ([a-z_]+):/gm), ['  schedule:', '  workflow_dispatch:']);
  assert.match(wf, /^    environment: production-snapshot$/m);
  assert.match(wf, /PGPASSWORD: \$\{\{ secrets\.SNAPSHOT_PGPASSWORD \}\}/);
  assert.match(wf, /@queryguardhq\/queryguard@\d+\.\d+\.\d+ snapshot/, 'pins an exact version');
  // The README's PR-check example must not need database credentials.
  const prExample = read('README.md').split('## Production snapshots')[1].split('```yaml')[1].split('```')[0];
  assert.match(prExample, /snapshot-path: '\.queryguard\/snapshot'/);
  assert.doesNotMatch(prExample, /PG(HOST|USER|PASSWORD)|pg-password/i);
});

test('relative links in the snapshot docs point at files that exist', () => {
  for (const f of ['README.md', 'docs/snapshot-security.md', 'docs/design/snapshot.md']) {
    for (const m of read(f).matchAll(/\]\(((?!https?:|#)[^)#\s]+)(#[^)]*)?\)/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, path.dirname(f), m[1])), `${f} links to missing ${m[1]}`);
    }
  }
});
