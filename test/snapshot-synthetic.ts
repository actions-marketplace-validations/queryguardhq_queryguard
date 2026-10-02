// A valid snapshot written without a database, for tests of what reads snapshots (inspect, the Action).
import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../src/snapshot/load';
import { Manifest, Redactions, Shape, Workload, WorkloadStatement } from '../src/snapshot/types';
import { validateSnapshot } from '../src/snapshot/validate';
import { stableStringify } from '../src/snapshot/writer';

export interface Synthetic {
  manifest: Manifest;
  shape: Shape;
  workload: Workload;
  redactions: Redactions;
  schemaSql: string;
  statsSql?: string;
}

const statement = (queryid: string, text: string, relations: string[], calls: number, total: number): WorkloadStatement => ({
  queryid, kind: text.startsWith('UPDATE') ? 'UPDATE' : 'SELECT', text, redaction: text.startsWith('[') ? 'literal' : null,
  calls, total_exec_ms: total, mean_exec_ms: Number((total / calls).toPrecision(2)), rows: calls, shared_blks_hit: calls,
  shared_blks_read: 0, relations, unresolved: [], unresolved_count: 0, selected_by: ['total_time', 'calls'],
});

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

/**
 * A production-like snapshot: orders (~48M rows), customers, an unindexed audit table. Taken a day
 * before `now`; pg_stat_statements was reset 30 days before that.
 */
export function synthetic(now: Date = new Date()): Synthetic {
  const relation = (name: string, reltuples: number, total: number, indexes: number) => ({
    schema: 'public', name, kind: 'table' as const, partition_of: null, reltuples, relpages: Math.round(total / 8192 / 2),
    relallvisible: 0, size_bytes: { table: total - indexes, indexes, total },
    activity: { n_live_tup: reltuples, n_dead_tup: 0, seq_scan: 12, idx_scan: 980000, n_tup_ins: 3100000, n_tup_upd: 2200000, n_tup_del: 0 },
    last_analyze: daysAgo(now, 2),
    columns: [{ name: 'id', attnum: 1, stats: [{ inherited: false, null_frac: 0, avg_width: 8, n_distinct: -1, correlation: 1, mcv_freqs: null }] }],
  });
  return {
    manifest: {
      format_version: 1, created_at: daysAgo(now, 1), label: 'prod-eu', server_version_num: 160004, mode: 'shape',
      precision: 'approx', status: 'COMPLETE', partial_reasons: [], tool_version: '1.3.1',
      schema_source: { kind: 'pg_dump', pg_dump_version: '18.6' }, files: {},
    },
    shape: {
      block_size: 8192, size_source: 'relpages', column_stats_source: 'pg_stats', stats_reset: { database: daysAgo(now, 31) },
      relations: [
        relation('orders', 48000000, 15000000000, 4100000000),
        relation('customers', 2100000, 900000000, 210000000),
        relation('audit_log', 310000000, 98000000000, 0),
      ],
      indexes: [],
    },
    workload: {
      source: { extension_version: '1.10', stats_reset: daysAgo(now, 31), dealloc: 0, window: { kind: 'since_reset' } },
      selection: { top: 200, candidates: 4, selected: 4 },
      statements: [
        // 30 days from the reset to the snapshot: 5.5B calls ≈ 2,100 calls/s.
        statement('-101', 'SELECT id, status FROM orders WHERE customer_id = $1', ['public.orders'], 5500000000, 61000000),
        statement('102', 'UPDATE orders SET status = $1 WHERE id = $2', ['public.orders'], 2600000, 9900000),
        statement('103', 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.email = $1', ['public.customers', 'public.orders'], 840000, 2300000),
        statement('104', '[redacted: literal]', ['public.customers'], 12, 340),
      ],
    },
    redactions: {
      schema: { removed_entries: { COMMENT: 2 }, removed_lines: { owner: 0, restrict: 2, connect: 0 } },
      workload: {
        entries_read: 1430, excluded: { not_dml: 402, text_hidden: 0, system_only: 190, no_relations: 26 }, comments_removed: 41,
        redacted: { literal: ['104'], unparseable: [] },
      },
    },
    schemaSql: '--\n-- PostgreSQL database dump\n--\n\nCREATE TABLE public.orders (id bigint);\n',
  };
}

/** Writes `s` as a snapshot directory with correct hashes. Throws if it would not validate. */
export function writeSynthetic(dir: string, s: Synthetic = synthetic()): void {
  const files: Record<string, string> = {
    'schema.sql': s.schemaSql,
    'shape.json': stableStringify(s.shape),
    'workload.json': stableStringify(s.workload),
    'redactions.json': stableStringify(s.redactions),
    ...(s.statsSql !== undefined ? { 'stats.sql': s.statsSql } : {}),
  };
  const manifest = { ...s.manifest, files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha256(c)])) };
  const invalid = validateSnapshot({ manifest, shape: s.shape, workload: s.workload, redactions: s.redactions });
  if (invalid.length > 0) throw new Error(`synthetic snapshot is invalid: ${invalid.join('; ')}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  fs.writeFileSync(path.join(dir, 'manifest.json'), stableStringify(manifest));
}
