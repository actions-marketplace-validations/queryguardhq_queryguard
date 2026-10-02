// Phase 1 / item 7: the Action annotates lock findings from a snapshot, without changing severities.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeTable, loadForAction } from '../src/snapshot/annotate';
import { loadSnapshot, Snapshot } from '../src/snapshot/load';
import { buildMarkdownReport } from '../src/reporter';
import { RunOutcome } from '../src/types';
import { assertPostgres16, createSandbox, reportStatus, runCli, Sandbox } from './harness';
import { synthetic, Synthetic, writeSynthetic } from './snapshot-synthetic';

function snapshotDir(s: Synthetic = synthetic()): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-action-snap-'));
  writeSynthetic(dir, s);
  return dir;
}
function load(s: Synthetic): Snapshot {
  const r = loadSnapshot(snapshotDir(s));
  assert.ok(r.ok);
  return r.snapshot;
}

describe('table annotations', () => {
  const s = load(synthetic());

  test('rows, size, query shapes and call rate, as in the spec example', () => {
    assert.equal(describeTable(s, 'orders'), '~48M rows · ~14 GB · 3 query shapes · ~2,100 calls/s');
    assert.equal(describeTable(s, 'public."orders"'), describeTable(s, 'orders'));
    assert.equal(describeTable(s, 'customers'), '~2.1M rows · ~860 MB · 2 query shapes · ~19 calls/min');
    assert.equal(describeTable(s, 'audit_log'), '~310M rows · ~91 GB · 0 query shapes');
  });

  test('names that do not resolve say so instead of guessing', () => {
    assert.match(describeTable(s, 'invoices'), /^not in the snapshot/);
    assert.equal(describeTable(s, 'unknown table'), 'table name not recognized');
    const two = synthetic();
    two.shape.relations.push({ ...two.shape.relations[0], schema: 'archive' });
    assert.equal(describeTable(load(two), 'orders'), 'ambiguous: orders exists in schemas public, archive');
    assert.match(describeTable(load(two), 'archive.orders'), /^~48M rows/);
  });

  test('a partitioned table sums its partitions', () => {
    const p = synthetic();
    const base = p.shape.relations[0];
    p.shape.relations = [
      { ...base, name: 'events', kind: 'partitioned_table', relpages: null, size_bytes: null, reltuples: 9000000 },
      { ...base, name: 'events_2025', partition_of: 'public.events', size_bytes: { table: 3 * 1024 ** 3, indexes: 0, total: 3 * 1024 ** 3 } },
      { ...base, name: 'events_2026', partition_of: 'public.events', size_bytes: { table: 1024 ** 3, indexes: 0, total: 1024 ** 3 } },
    ];
    p.workload.statements = [{ ...p.workload.statements[0], relations: ['public.events_2026'] }];
    assert.equal(describeTable(load(p), 'events'), '~9M rows · ~4 GB · 2 partitions · 1 query shape · ~2,100 calls/s');
  });

  test('missing workload, unknown reset time, failed relation', () => {
    const none = synthetic();
    none.workload = { source: null, selection: { top: 200, candidates: 0, selected: 0 }, statements: [] };
    none.manifest.status = 'PARTIAL';
    none.manifest.partial_reasons = [{ scope: 'workload', reason: 'pg_stat_statements is not installed' }];
    assert.equal(describeTable(load(none), 'orders'), '~48M rows · ~14 GB · no workload data');

    const noReset = synthetic();
    noReset.workload.source!.stats_reset = null;
    assert.equal(describeTable(load(noReset), 'orders'), '~48M rows · ~14 GB · 3 query shapes · ~5.5B calls (rate unknown)');

    const failed = synthetic();
    failed.shape.relations[0].error = 'canceling statement due to lock timeout';
    failed.manifest.status = 'PARTIAL';
    failed.manifest.partial_reasons = [{ scope: 'shape:public.orders', reason: 'collection failed: canceling statement due to lock timeout' }];
    assert.equal(describeTable(load(failed), 'orders'), 'no snapshot data: canceling statement due to lock timeout');
  });
});

describe('loading for the Action', () => {
  test('a fresh snapshot gives its context; an old one is stale', () => {
    const fresh = loadForAction(snapshotDir(), '14');
    assert.ok(fresh.ok && !fresh.context.stale && fresh.context.label === 'prod-eu');
    const old = synthetic(new Date(Date.now() - 30 * 86_400_000));
    const stale = loadForAction(snapshotDir(old), '14');
    assert.ok(stale.ok && stale.context.stale);
    const lenient = loadForAction(snapshotDir(old), '60');
    assert.ok(lenient.ok && !lenient.context.stale, 'the limit is configurable');
  });

  test('anything unusable is a reason, never a silent skip', () => {
    assert.deepEqual(loadForAction(snapshotDir(), '0'), { ok: false, reason: 'snapshot-max-age-days must be a positive number, got "0"' });
    const dir = snapshotDir();
    fs.writeFileSync(path.join(dir, 'shape.json'), '{}');
    const r = loadForAction(dir, '14');
    assert.ok(!r.ok && /invalid snapshot: shape\.json does not match its SHA-256/.test(r.reason));
    assert.ok(!loadForAction(path.join(dir, 'missing'), '14').ok);
  });
});

describe('report', () => {
  const lock = (): RunOutcome => ({
    lockFindings: [
      { query: 'CREATE INDEX i ON orders (status)', totalCost: 0, hasSeqScan: false, isLockRisk: true, lockType: 'SHARE', targetTable: 'orders', recommendation: 'Use CONCURRENTLY' },
    ],
    scanFindings: [],
    skipped: [],
  });
  const context = (over: Partial<NonNullable<RunOutcome['snapshot']>> = {}): NonNullable<RunOutcome['snapshot']> => ({
    label: 'prod-eu', createdAt: new Date(Date.now() - 86_400_000).toISOString(), ageDays: 1, maxAgeDays: 14, stale: false,
    status: 'COMPLETE', partialReasons: [], server: 'PostgreSQL 16.4', window: 'average since the pg_stat_statements reset on 2026-09-01', ...over,
  });

  test('without a snapshot the findings table is unchanged', () => {
    assert.doesNotMatch(buildMarkdownReport(lock()), /Production/);
  });

  test('with one: a production column, and a line saying where the figures come from', () => {
    const o = lock();
    o.snapshot = context();
    o.lockFindings[0].productionContext = '~48M rows · ~14 GB · 3 query shapes · ~2,100 calls/s';
    const md = buildMarkdownReport(o);
    assert.match(md, /\| Severity \| Issue Type \| Target Table \| Production \(snapshot\) \| Impact \| Suggested Fix \|/);
    assert.match(md, /\| `orders` \| ~48M rows · ~14 GB · 3 query shapes · ~2,100 calls\/s \| Blocks concurrent table writes/);
    assert.match(md, /Production context from snapshot `prod-eu` \(PostgreSQL 16\.4, taken \d{4}-\d{2}-\d{2}, 1 day ago\)\. Figures are approximate; call rates are the average since the pg_stat_statements reset on 2026-09-01\. They do not change any severity\./);
    assert.ok(!/Stale|Partial snapshot/.test(md));
  });

  test('stale and partial snapshots are flagged right under the status', () => {
    const o = lock();
    o.snapshot = context({ stale: true, ageDays: 23, createdAt: new Date(Date.now() - 23 * 86_400_000).toISOString(), status: 'PARTIAL', partialReasons: ['workload: pg_stat_statements is not installed'] });
    const lines = buildMarkdownReport(o).split('\n');
    const status = lines.findIndex((l) => /Status:/.test(l));
    assert.match(lines[status + 2], /^> ⚠️ \*\*Stale snapshot:\*\* `prod-eu` was taken 23 days ago, more than `snapshot-max-age-days` \(14\)/);
    assert.match(lines.slice(status + 3, status + 7).join('\n'), /> ⚠️ \*\*Partial snapshot:\*\* `prod-eu` is missing some production context:\n> - workload: pg_stat_statements is not installed/);
  });
});

describe('the Action, end to end', () => {
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
  const SCHEMA = `CREATE TABLE orders (id bigserial PRIMARY KEY, status text NOT NULL);`;
  const QUERY = `SELECT id FROM orders WHERE id = 1;`;

  test('lock findings get production context; status and exit code are exactly as without a snapshot', async () => {
    // Each run applies the schema and migration, so each needs its own database.
    const run = (extraEnv: Record<string, string>) =>
      withSandbox((sb) => {
        const r = runCli(sb, {
          schema: sb.write('schema.sql', SCHEMA),
          migration: sb.write('migration.sql', 'CREATE INDEX orders_status_idx ON orders (status);'),
          queries: sb.write('queries.sql', QUERY),
          strict: true,
          extraEnv,
        });
        results.push(r);
      });
    const results: ReturnType<typeof runCli>[] = [];
    await run({});
    await run({ INPUT_SNAPSHOT_PATH: snapshotDir() });
    const [without, withSnap] = results;
    {
      assert.equal(reportStatus(without), 'FAIL');
      assert.equal(reportStatus(withSnap), 'FAIL');
      assert.equal(withSnap.exitCode, without.exitCode);
      assert.match(withSnap.report, /\| `orders` \| ~48M rows · ~14 GB · 3 query shapes · ~2,100 calls\/s \|/);
      assert.match(withSnap.report, /Production context from snapshot `prod-eu`/);
    }
  });

  test('an invalid snapshot makes an otherwise clean run INCONCLUSIVE', () =>
    withSandbox((sb) => {
      const dir = snapshotDir();
      fs.appendFileSync(path.join(dir, 'schema.sql'), '-- edited\n');
      const r = runCli(sb, {
        schema: sb.write('schema.sql', SCHEMA),
        queries: sb.write('queries.sql', QUERY),
        strict: true,
        extraArgs: ['--snapshot', dir],
      });
      assert.equal(reportStatus(r), 'INCONCLUSIVE', r.report);
      assert.equal(r.exitCode, 2);
      assert.match(r.report, /\| snapshot \| `.*` \|  \| invalid snapshot: schema\.sql does not match its SHA-256/);
    }));

  test('a stale snapshot warns at the top and changes nothing else', () =>
    withSandbox((sb) => {
      const r = runCli(sb, {
        schema: sb.write('schema.sql', SCHEMA),
        queries: sb.write('queries.sql', QUERY),
        strict: true,
        extraArgs: ['--snapshot', snapshotDir(synthetic(new Date(Date.now() - 40 * 86_400_000))), '--snapshot-max-age-days', '30'],
      });
      assert.equal(reportStatus(r), 'PASS', r.report);
      assert.equal(r.exitCode, 0);
      assert.match(r.report.split('\n').slice(0, 8).join('\n'), /Stale snapshot:\*\* `prod-eu` was taken 41 days ago, more than `snapshot-max-age-days` \(30\)/);
    }));
});
