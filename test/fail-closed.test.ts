// Phase 0 / item 1: tests that pin the *required* fail-closed behavior.
// Before item 2 lands, every test here except the control is expected to fail:
// today each scenario yields a clean-looking "All checks passed" report and exit 0.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { splitSqlStatementsWithLines } from '../src/splitter';
import { assertPostgres16, createSandbox, runCli, reportStatus, Sandbox } from './harness';

const OK_SCHEMA = `CREATE TABLE widgets (id serial PRIMARY KEY, name text NOT NULL);`;
const OK_QUERY = `SELECT id FROM widgets WHERE id = 1;`;

before(async () => {
  await assertPostgres16();
});

async function withSandbox(fn: (sb: Sandbox) => void | Promise<void>) {
  const sb = await createSandbox();
  try {
    await fn(sb);
  } finally {
    await sb.cleanup();
  }
}

function assertNotClean(report: string) {
  assert.doesNotMatch(report, /All checks passed/i, 'report must not claim a clean pass');
  assert.doesNotMatch(report, /\bCLEAN\b/);
}

describe('control', () => {
  test('a fully healthy run passes with exit 0 and no skipped items', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', OK_SCHEMA),
        queries: sb.write('queries.sql', OK_QUERY),
        strict: true,
      });
      assert.equal(r.exitCode, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.report, /INCONCLUSIVE|skipped/i);
    }));
});

describe('migration statement errors', () => {
  const migration = `-- add a column\nALTER TABLE widgets ADD COLUMN ok int;\n\nALTER TABLE does_not_exist ADD COLUMN x int;\n`;

  test('strict: FAIL, exit 1, reports statement, line number and Postgres error', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', OK_SCHEMA),
        migration: sb.write('migration.sql', migration),
        queries: sb.write('queries.sql', OK_QUERY),
        strict: true,
      });
      assert.equal(reportStatus(r), 'FAIL', r.report);
      assert.equal(r.exitCode, 1);
      assertNotClean(r.report);
      assert.match(r.report, /ALTER TABLE does_not_exist/);
      assert.match(r.report, /line 4\b/i);
      assert.match(r.report, /relation "does_not_exist" does not exist/);
    }));

  test('advisory: job passes (exit 0) but the report leads with FAIL', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', OK_SCHEMA),
        migration: sb.write('migration.sql', migration),
        queries: sb.write('queries.sql', OK_QUERY),
        strict: false,
      });
      assert.equal(r.exitCode, 0);
      assert.equal(reportStatus(r), 'FAIL', r.report);
      const firstLines = r.report.split('\n').slice(0, 6).join('\n');
      assert.match(firstLines, /Status:\**\s*\**FAIL/, 'status must lead the report');
    }));
});

describe('baseline schema statement errors', () => {
  const schema = `CREATE TABLE widgets (id int PRIMARY KEY);\nCREATE TABLE widgets (id int PRIMARY KEY);\n`;

  test('strict: INCONCLUSIVE, exit 2, names the failed baseline statement', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', schema),
        queries: sb.write('queries.sql', 'SELECT 1;'),
        strict: true,
      });
      assert.equal(reportStatus(r), 'INCONCLUSIVE', r.report);
      assert.equal(r.exitCode, 2);
      assertNotClean(r.report);
      assert.match(r.report, /relation "widgets" already exists/);
    }));

  test('advisory: exit 0 but report leads with INCONCLUSIVE', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', schema),
        queries: sb.write('queries.sql', 'SELECT 1;'),
        strict: false,
      });
      assert.equal(r.exitCode, 0);
      assert.equal(reportStatus(r), 'INCONCLUSIVE', r.report);
    }));
});

describe('tables the synthetic generator cannot populate', () => {
  test('custom enum type (NOT NULL): table skipped, INCONCLUSIVE, exit 2', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write(
          'schema.sql',
          `CREATE TYPE mood AS ENUM ('happy','sad');\nCREATE TABLE people (id int PRIMARY KEY, feeling mood NOT NULL);`
        ),
        queries: sb.write('queries.sql', 'SELECT id FROM people WHERE id = 1;'),
        strict: true,
      });
      assert.equal(reportStatus(r), 'INCONCLUSIVE', r.report);
      assert.equal(r.exitCode, 2);
      assertNotClean(r.report);
      assert.match(r.report, /people/);
      assert.match(r.report, /invalid input value for enum mood/);
    }));

  test('generated column: table skipped, INCONCLUSIVE, exit 2', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write(
          'schema.sql',
          `CREATE TABLE prices (id int PRIMARY KEY, net int NOT NULL, gross int GENERATED ALWAYS AS (net * 2) STORED);`
        ),
        queries: sb.write('queries.sql', 'SELECT id FROM prices WHERE id = 1;'),
        strict: true,
      });
      assert.equal(reportStatus(r), 'INCONCLUSIVE', r.report);
      assert.equal(r.exitCode, 2);
      assertNotClean(r.report);
      assert.match(r.report, /prices/);
    }));
});

describe('known generator limitation', () => {
  // The generator fills int columns with (i % 100) + 1, so an int PK/unique column without a
  // default collides. This used to be swallowed; it must now surface as INCONCLUSIVE.
  test('int primary key without a default: table skipped, INCONCLUSIVE', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', `CREATE TABLE things (id int PRIMARY KEY);`),
        queries: sb.write('queries.sql', 'SELECT id FROM things WHERE id = 1;'),
        strict: true,
      });
      assert.equal(reportStatus(r), 'INCONCLUSIVE', r.report);
      assert.equal(r.exitCode, 2);
      assert.match(r.report, /things/);
      assert.match(r.report, /duplicate key value/);
    }));
});

describe('job summary', () => {
  test('GITHUB_STEP_SUMMARY receives the report, leading with the status', () =>
    withSandbox((sb) => {
      const summary = `${sb.dir}/summary.md`;
      const r = runCli(sb, {
        schema: sb.write('schema.sql', OK_SCHEMA),
        queries: sb.write('queries.sql', 'SELECT * FROM no_such_table;'),
        extraEnv: { GITHUB_STEP_SUMMARY: summary },
      });
      assert.equal(r.exitCode, 0);
      const text = fs.readFileSync(summary, 'utf8');
      assert.match(text.split('\n').slice(0, 6).join('\n'), /Status:\**\s*\**INCONCLUSIVE/);
    }));
});

describe('splitter line numbers', () => {
  test('lines survive comments, blank lines and psql meta-commands', () => {
    const sql = `\\set ON_ERROR_STOP on\n-- c\nSELECT 1;\n\n/* b\n*/ SELECT 2;\n  SELECT 3`;
    assert.deepEqual(
      splitSqlStatementsWithLines(sql).map((s) => [s.sql, s.line]),
      [['SELECT 1', 3], ['SELECT 2', 6], ['SELECT 3', 7]]
    );
  });
});

describe('queries.sql entries that error', () => {
  const queries = `SELECT id FROM widgets WHERE id = 1;\n\nSELECT * FROM no_such_table;\n`;

  test('strict: query skipped, INCONCLUSIVE, exit 2, lists the query and the reason', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', OK_SCHEMA),
        queries: sb.write('queries.sql', queries),
        strict: true,
      });
      assert.equal(reportStatus(r), 'INCONCLUSIVE', r.report);
      assert.equal(r.exitCode, 2);
      assertNotClean(r.report);
      assert.match(r.report, /no_such_table/);
      assert.match(r.report, /relation "no_such_table" does not exist/);
    }));

  test('advisory: exit 0 but report leads with INCONCLUSIVE', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', OK_SCHEMA),
        queries: sb.write('queries.sql', queries),
        strict: false,
      });
      assert.equal(r.exitCode, 0);
      assert.equal(reportStatus(r), 'INCONCLUSIVE', r.report);
    }));
});
