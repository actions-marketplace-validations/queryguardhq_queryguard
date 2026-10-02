// The web sandbox (index.html) reimplements a simplified version of the rules in browser JS.
// These tests run the page's real script and pin it to the product's analyzer, so the page
// cannot silently drift from what the CLI and Action actually do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { analyzeDDLLocks } from '../src/locks';
import { splitSqlStatements } from '../src/splitter';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)![1];

function loadPage(inputs: { ddl?: string; queries?: string; fail?: string; tx?: string } = {}) {
  const els: Record<string, any> = {
    ddlInput: { value: inputs.ddl ?? '' },
    queryInput: { value: inputs.queries ?? '' },
    simulationOutput: { innerHTML: '' },
    cfgSchema: { value: 'db/schema.sql' },
    cfgMigration: { value: 'db/migrations/latest.sql' },
    cfgQueries: { value: 'db/queries.sql' },
    cfgFail: { value: inputs.fail ?? 'false' },
    cfgTx: { value: inputs.tx ?? 'false' },
    yamlOutput: { textContent: '' },
  };
  const ctx: any = { document: { getElementById: (id: string) => els[id], querySelectorAll: () => [] }, navigator: {} };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return { els, run: () => vm.runInContext('runClientSimulation()', ctx) };
}

const sandboxFindings = (ddl: string): string[] => {
  const page = loadPage({ ddl });
  page.run();
  const out: string = page.els.simulationOutput.innerHTML;
  const rows = out.match(/<td><code>([^<]*)<\/code><\/td><td><code>[^<]*<\/code><td>|<td class="tag-danger">🚨 CRITICAL<\/td><td><code>([^<]*)<\/code>/g) || [];
  return [...out.matchAll(/🚨 CRITICAL<\/td><td><code>([^<]*)<\/code>/g)].map((m) => m[1]);
};

const productLabel = (sql: string): string[] =>
  analyzeDDLLocks(splitSqlStatements(sql)).map((f) =>
    f.transactionHazard ? 'CONCURRENTLY in a transaction' : f.lockType === 'SHARE' ? 'SHARE Lock' : 'ACCESS EXCLUSIVE'
  );

const CASES = [
  'CREATE INDEX idx_a ON t(c);',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_b ON t (c) WHERE c > 0;',
  'CREATE INDEX "Idx A" ON app."Mixed Case" ("Col");',
  'CREATE INDEX ON t (c);',
  'CREATE INDEX CONCURRENTLY idx_c ON t(c);',
  'ALTER TABLE t ALTER COLUMN c TYPE bigint;',
  'ALTER TABLE app."Mixed Case" ALTER "Col" SET DATA TYPE numeric(12,2);',
  'BEGIN;\nCREATE INDEX CONCURRENTLY i ON t(c);\nCOMMIT;',
  'BEGIN; SELECT 1; COMMIT;\nCREATE INDEX CONCURRENTLY i ON t(c);',
  '-- CREATE INDEX in a comment\nSELECT 1;',
];

for (const sql of CASES) {
  test(`sandbox agrees with the analyzer: ${JSON.stringify(sql).slice(0, 60)}`, () => {
    assert.deepEqual(sandboxFindings(sql), productLabel(sql));
  });
}

test('status leads: FAIL on a lock, PASS otherwise', () => {
  const fail = loadPage({ ddl: 'CREATE INDEX i ON t(c);' });
  fail.run();
  assert.match(fail.els.simulationOutput.innerHTML, /Status: FAIL/);
  const pass = loadPage({ ddl: 'CREATE INDEX CONCURRENTLY i ON t(c);' });
  pass.run();
  assert.match(pass.els.simulationOutput.innerHTML, /Status: PASS/);
});

test('seq-scan hints are informational, carry the caveat, and invent no numbers', () => {
  const page = loadPage({ ddl: '', queries: "SELECT * FROM users WHERE email = 'x';" });
  page.run();
  const out: string = page.els.simulationOutput.innerHTML;
  assert.match(out, /Informational: possible sequential scan/);
  assert.doesNotMatch(out, /CRITICAL/);
  assert.doesNotMatch(out, /Cost:|~2,000/);
  assert.match(out, /not evidence of production safety/);
});

test('user input is HTML-escaped in the preview', () => {
  const page = loadPage({ ddl: 'CREATE INDEX i ON "<img src=x onerror=alert(1)>"(c);' });
  page.run();
  assert.doesNotMatch(page.els.simulationOutput.innerHTML, /<img/);
});

test('generated workflow reflects strict mode and assume-in-transaction', () => {
  const page = loadPage({ fail: 'true', tx: 'true' });
  const yaml: string = page.els.yamlOutput.textContent;
  assert.match(yaml, /fail-on-sev1: 'true'/);
  assert.match(yaml, /assume-in-transaction: 'true'/);
  assert.match(yaml, /^name: QueryGuard$/m);
  assert.match(yaml, /^  queryguard:$/m);
  assert.doesNotMatch(yaml, /blast/i);
});
