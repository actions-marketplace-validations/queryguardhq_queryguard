// Phase 1 / item 6: `queryguard snapshot inspect <dir>`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approxBytes, approxCount, age, duration, pgVersion, rate } from '../src/snapshot/display';
import { runSnapshotCli } from './snapshot-harness';
import { synthetic, writeSynthetic } from './snapshot-synthetic';

function withTmp(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-inspect-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const inspect = (dir: string) => runSnapshotCli(['inspect', dir], {}, os.tmpdir());

describe('figures for people', () => {
  test('counts, sizes, durations, rates, ages, versions', () => {
    assert.deepEqual([12, 999, 1500, 5000, 48213551, 5.5e9].map(approxCount), ['12', '999', '~1,500', '~5,000', '~48M', '~5.5B']);
    assert.deepEqual([512, 4096, 15032385536].map(approxBytes), ['512 bytes', '~4 kB', '~14 GB']);
    assert.deepEqual([0.0114, 340, 81000, 9900000, 61000000, 900000000].map(duration), ['0.011 ms', '340 ms', '~81 s', '~2.8 h', '~17 h', '~10 days']);
    assert.deepEqual([2134.5, 0.5, 0.001].map(rate), ['~2,100 calls/s', '~30 calls/min', '~3.6 calls/h']);
    const now = new Date('2026-10-04T12:00:00Z');
    assert.equal(age('2026-10-01T12:00:00.000Z', now), '3 days ago');
    assert.equal(age('2026-10-04T11:59:30.000Z', now), 'just now');
    assert.deepEqual([180006, 140019].map(pgVersion), ['18.6', '14.19']);
  });
});

describe('snapshot inspect', () => {
  test('a valid snapshot: summary, largest tables, hottest shapes and the full redaction report', () =>
    withTmp((dir) => {
      writeSynthetic(dir);
      const r = inspect(dir);
      assert.equal(r.exitCode, 0, r.stderr);
      for (const want of [
        /QueryGuard snapshot: prod-eu/,
        /Status\s+COMPLETE/,
        /Server\s+PostgreSQL 16\.4/,
        /Mode\s+shape \(no value from any row\)/,
        /Integrity\s+5 files match their SHA-256/,
        /Relations\s+3 \(3 tables\)/,
        /Largest tables[\s\S]*public\.audit_log\s+~310M\s+~91 GB[\s\S]*public\.orders\s+~48M\s+~14 GB/,
        /Hottest query shapes[\s\S]*~5\.5B\s+~17 h\s+0\.011 ms\s+public\.orders\s+SELECT id, status FROM orders WHERE customer_id = \$1/,
        /Excluded: 402 utility commands, 0 with text hidden by privileges, 190 touching only system catalogs, 26 touching no relation\./,
        /Text replaced \(a literal survived normalization\): 1, queryids 104/,
        /schema\.sql: objects removed: COMMENT 2\./,
        /Never collected: host, port, user, database name, role names/,
      ]) {
        assert.match(r.stdout, want);
      }
    }));

  test('PARTIAL: exit 2 and every reason listed first', () =>
    withTmp((dir) => {
      const s = synthetic();
      s.manifest.status = 'PARTIAL';
      s.manifest.partial_reasons = [{ scope: 'workload', reason: 'pg_stat_statements is not installed in this database' }];
      writeSynthetic(dir, s);
      const r = inspect(dir);
      assert.equal(r.exitCode, 2);
      assert.match(r.stdout, /Status\s+PARTIAL \(1 reason, below\)[\s\S]*Partial: not everything could be collected\n  - workload: pg_stat_statements is not installed/);
    }));

  test('full mode names the columns whose values left production', () =>
    withTmp((dir) => {
      const s = synthetic();
      s.manifest.mode = 'full';
      s.manifest.allowed_columns = ['public.orders.status'];
      s.statsSql = 'SET standard_conforming_strings = on;\n';
      writeSynthetic(dir, s);
      const r = inspect(dir);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /Mode\s+full \(stats\.sql has value statistics for 1 allow-listed column\(s\)\)/);
      assert.match(r.stdout, /allow-listed columns, in stats\.sql:\n    - public\.orders\.status/);
    }));

  test('an old snapshot says the Action will call it stale', () =>
    withTmp((dir) => {
      const s = synthetic();
      s.manifest.created_at = '2020-01-01T00:00:00.000Z';
      writeSynthetic(dir, s);
      assert.match(inspect(dir).stdout, /older than 14 days, so the Action will warn that it is stale/);
    }));

  test('an invalid snapshot: exit 1, the problems, and no summary', () =>
    withTmp((dir) => {
      writeSynthetic(dir);
      fs.appendFileSync(path.join(dir, 'workload.json'), ' ');
      const r = inspect(dir);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /is not a valid snapshot; do not use it:\n  - workload\.json does not match its SHA-256/);
      assert.equal(r.stdout, '');
      assert.equal(inspect(path.join(dir, 'nope')).exitCode, 1);
    }));
});
