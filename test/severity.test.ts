// Phase 0 / item 4: sequential scans on synthetic data are informational.
// Only lock findings (and migration failures) may fail strict mode.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertPostgres16, createSandbox, runCli, reportStatus, Sandbox } from './harness';
import { computeStatus } from '../src/status';

const SCHEMA = `CREATE TABLE widgets (id serial PRIMARY KEY, name text NOT NULL);`;
const SEQ_SCAN_QUERY = `SELECT * FROM widgets WHERE name = 'sample_7active';`;
const PK_QUERY = `SELECT * FROM widgets WHERE id = 1;`;
const LOCK_MIGRATION = `CREATE INDEX idx_widgets_name ON widgets(name);`;
const CAVEAT = /clean query section is not evidence of production safety/i;

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

describe('sequential scans', () => {
  test('strict mode: a seq scan alone is PASS, exit 0, reported as informational', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', SCHEMA),
        queries: sb.write('q.sql', SEQ_SCAN_QUERY),
        strict: true,
      });
      assert.equal(r.exitCode, 0, r.report);
      assert.equal(reportStatus(r), 'PASS');
      assert.match(r.report, /Informational: sequential scan on synthetic data/);
      assert.match(r.report, /widgets/);
      assert.doesNotMatch(r.report, /CRITICAL/);
      assert.match(r.report, CAVEAT);
    }));

  test('a clean query section still carries the not-production-safety caveat', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', SCHEMA),
        queries: sb.write('q.sql', PK_QUERY),
        strict: true,
      });
      assert.equal(r.exitCode, 0);
      assert.equal(reportStatus(r), 'PASS');
      assert.match(r.report, /No sequential scans were found/);
      assert.match(r.report, CAVEAT);
    }));

  test('the caveat names the synthetic row count', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', SCHEMA),
        queries: sb.write('q.sql', PK_QUERY),
        extraArgs: ['--mock-rows', '500'],
      });
      assert.match(r.report, /~500 synthetic rows per table/);
    }));

  test('a lock plus a seq scan: FAIL on the lock alone; the seq scan stays informational', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', SCHEMA),
        migration: sb.write('m.sql', LOCK_MIGRATION),
        queries: sb.write('q.sql', SEQ_SCAN_QUERY),
        strict: true,
      });
      assert.equal(r.exitCode, 1);
      assert.equal(reportStatus(r), 'FAIL');
      assert.match(r.report, /blocking migration lock/);
      assert.equal((r.report.match(/CRITICAL/g) || []).length, 1, 'only the lock is critical');
      assert.match(r.report, /Informational: sequential scan on synthetic data/);
    }));

  test('queries are not reported when the run stopped before evaluating them', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('s.sql', `CREATE TABLE a(id int); CREATE TABLE a(id int);`),
        queries: sb.write('q.sql', PK_QUERY),
      });
      assert.doesNotMatch(r.report, /Informational: sequential scan/);
    }));
});

describe('computeStatus', () => {
  const scan = { query: 'q', totalCost: 1, hasSeqScan: true };
  const lock = { query: 'm', totalCost: 0, hasSeqScan: false, isLockRisk: true };
  const base = { lockFindings: [], scanFindings: [], skipped: [] };

  test('seq scans never change the status', () => {
    assert.equal(computeStatus({ ...base, scanFindings: [scan, scan] }), 'PASS');
    assert.equal(computeStatus({ ...base, scanFindings: [scan], lockFindings: [lock] }), 'FAIL');
  });
});
