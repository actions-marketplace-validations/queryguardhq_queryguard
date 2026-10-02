// Phase 0 / item 5: transaction awareness for CREATE INDEX CONCURRENTLY.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { analyzeDDLLocks, TRANSACTION_OPT_OUT_NOTE } from '../src/locks';
import { splitSqlStatements } from '../src/splitter';
import { transactionControl } from '../src/ddl';
import { assertPostgres16, createSandbox, runCli, reportStatus, Sandbox } from './harness';

const SCHEMA = `CREATE TABLE widgets (id serial PRIMARY KEY, name text NOT NULL);`;
const QUERY = `SELECT * FROM widgets WHERE id = 1;`;
const CONCURRENT = `CREATE INDEX CONCURRENTLY idx_w ON widgets(name);`;

const analyze = (sql: string, assumeInTransaction = false) =>
  analyzeDDLLocks(splitSqlStatements(sql), { assumeInTransaction });

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

describe('transactionControl', () => {
  const cases: Array<[string, 'begin' | 'end' | null]> = [
    ['BEGIN', 'begin'],
    ['begin transaction isolation level serializable', 'begin'],
    ['START TRANSACTION READ ONLY', 'begin'],
    ['COMMIT', 'end'],
    ['END', 'end'],
    ['ROLLBACK', 'end'],
    ['ABORT', 'end'],
    ['ROLLBACK TO SAVEPOINT s', null],
    ['COMMIT PREPARED \'x\'', null],
    ['ROLLBACK PREPARED \'x\'', null],
    ['SAVEPOINT s', null],
    ['SELECT 1', null],
    ['CREATE TABLE begin_table (id int)', null],
  ];
  for (const [sql, want] of cases) {
    test(`${sql} -> ${want}`, () => assert.equal(transactionControl(sql), want));
  }
});

describe('static analysis', () => {
  test('CONCURRENTLY inside BEGIN...COMMIT is a transaction hazard that fails the gate', () => {
    const f = analyze(`BEGIN;\n${CONCURRENT}\nCOMMIT;`);
    assert.equal(f.length, 1);
    assert.equal(f[0].transactionHazard, true);
    assert.equal(f[0].isLockRisk, undefined);
    assert.equal(f[0].targetTable, 'widgets');
  });

  test('START TRANSACTION counts as an explicit block too', () => {
    assert.equal(analyze(`START TRANSACTION;\n${CONCURRENT}\nCOMMIT;`).length, 1);
  });

  test('CONCURRENTLY outside any transaction is clean', () => {
    assert.equal(analyze(CONCURRENT).length, 0);
  });

  test('CONCURRENTLY after COMMIT, or after ROLLBACK, is clean', () => {
    assert.equal(analyze(`BEGIN; SELECT 1; COMMIT;\n${CONCURRENT}`).length, 0);
    assert.equal(analyze(`BEGIN; SELECT 1; ROLLBACK;\n${CONCURRENT}`).length, 0);
  });

  test('ROLLBACK TO SAVEPOINT does not end the block', () => {
    assert.equal(analyze(`BEGIN; SAVEPOINT s; ROLLBACK TO SAVEPOINT s;\n${CONCURRENT}; COMMIT;`).length, 1);
  });

  test('a BEGIN inside a dollar-quoted DO block is not an explicit transaction', () => {
    const sql = `DO $$ BEGIN PERFORM 1; END $$;\n${CONCURRENT}`;
    assert.equal(analyze(sql).length, 0);
  });

  test('assumeInTransaction: CONCURRENTLY alone is a hazard', () => {
    assert.equal(analyze(CONCURRENT, true).length, 1);
    assert.equal(analyze(CONCURRENT, false).length, 0);
  });

  test('assumeInTransaction: an explicit COMMIT ends the assumed transaction', () => {
    assert.equal(analyze(`SELECT 1; COMMIT;\n${CONCURRENT}`, true).length, 0);
  });

  test('every CREATE INDEX remediation says how to opt out of the transaction', () => {
    for (const [sql, assume] of [
      ['CREATE INDEX idx_w ON widgets(name)', false],
      ['CREATE INDEX idx_w ON widgets(name)', true],
      [`BEGIN; CREATE INDEX idx_w ON widgets(name); COMMIT;`, false],
    ] as const) {
      const [f] = analyze(sql, assume);
      assert.ok(f.remediation!.notes.includes(TRANSACTION_OPT_OUT_NOTE), sql);
      assert.match(TRANSACTION_OPT_OUT_NOTE, /disable_ddl_transaction!/);
      assert.match(TRANSACTION_OPT_OUT_NOTE, /atomic = False/);
    }
  });

  test('inside a transaction the fix says to leave it', () => {
    const [f] = analyze(`BEGIN; CREATE INDEX idx_w ON widgets(name); COMMIT;`);
    assert.match(f.remediation!.summary, /outside a transaction/);
    assert.deepEqual(f.remediation!.sql, ['CREATE INDEX CONCURRENTLY idx_w ON widgets(name);']);
  });

  test('the hazard fix is the same statement, to be run outside the transaction', () => {
    const [f] = analyze(`BEGIN;\n${CONCURRENT}\nCOMMIT;`);
    assert.deepEqual(f.remediation!.sql, [CONCURRENT]);
  });
});

describe('CLI', () => {
  test('explicit BEGIN...COMMIT around CONCURRENTLY: FAIL, exit 1, real Postgres error shown', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', SCHEMA),
        migration: sb.write('m.sql', `BEGIN;\n${CONCURRENT}\nCOMMIT;`),
        queries: sb.write('q.sql', QUERY),
        strict: true,
      });
      assert.equal(r.exitCode, 1, r.report);
      assert.equal(reportStatus(r), 'FAIL');
      assert.match(r.report, /CONCURRENTLY.* in a transaction/);
      assert.match(r.report, /cannot run inside a transaction block/);
      assert.match(r.report, /disable_ddl_transaction!/);
    }));

  test('without the flag, a bare CONCURRENTLY migration passes', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', SCHEMA),
        migration: sb.write('m.sql', CONCURRENT),
        queries: sb.write('q.sql', QUERY),
        strict: true,
      });
      assert.equal(r.exitCode, 0, r.report);
      assert.equal(reportStatus(r), 'PASS');
      assert.doesNotMatch(r.report, /assume-in-transaction/);
    }));

  for (const [label, extra] of [
    ['--assume-in-transaction (bare)', { extraArgs: ['--assume-in-transaction'] }],
    ['--assume-in-transaction true', { extraArgs: ['--assume-in-transaction', 'true'] }],
    ['INPUT_ASSUME_IN_TRANSACTION=true', { extraEnv: { INPUT_ASSUME_IN_TRANSACTION: 'true' } }],
  ] as const) {
    test(`${label}: a bare CONCURRENTLY migration FAILs and the report says it assumed a transaction`, () =>
      withSandbox((sb) => {
        const r = runCli(sb, {
          schema: sb.write('s.sql', SCHEMA),
          migration: sb.write('m.sql', CONCURRENT),
          queries: sb.write('q.sql', QUERY),
          strict: true,
          ...extra,
        });
        assert.equal(r.exitCode, 1, r.report);
        assert.equal(reportStatus(r), 'FAIL');
        assert.match(r.report, /assume-in-transaction/);
        assert.match(r.report, /cannot run inside a transaction block/);
      }));
  }

  test('--assume-in-transaction false is honored, and a following flag is not swallowed', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', SCHEMA),
        migration: sb.write('m.sql', CONCURRENT),
        queries: sb.write('q.sql', QUERY),
        strict: true,
        extraArgs: ['--assume-in-transaction', 'false'],
      });
      assert.equal(r.exitCode, 0, r.report);
    }));

  test('assume-in-transaction: a non-concurrent migration still applies (BEGIN/COMMIT)', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', SCHEMA),
        migration: sb.write('m.sql', `ALTER TABLE widgets ADD COLUMN note text;`),
        queries: sb.write('q.sql', `SELECT note FROM widgets WHERE id = 1;`),
        strict: true,
        extraArgs: ['--assume-in-transaction'],
      });
      assert.equal(r.exitCode, 0, r.report);
      assert.equal(reportStatus(r), 'PASS');
    }));

  test('--lint honors --assume-in-transaction', () =>
    withSandbox((sb) => {
      const file = sb.write('m.sql', CONCURRENT);
      const lint = (...extra: string[]) =>
        spawnSync(
          process.execPath,
          [path.resolve(__dirname, '../node_modules/tsx/dist/cli.mjs'), path.resolve(__dirname, '../src/index.ts'), '--lint', '--migration', file, ...extra],
          { encoding: 'utf8' }
        );
      assert.equal(lint().status, 0);
      const bad = lint('--assume-in-transaction');
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /\[TRANSACTION\]/);
      assert.match(bad.stderr, /disable_ddl_transaction!/);
    }));
});
