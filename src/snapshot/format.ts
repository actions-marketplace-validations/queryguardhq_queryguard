// Number formatting for the artifact. One rule, so a reviewer can check it at a glance:
//   approx (default): every measurement (counts, sizes, pages, counters, calls, times) is rounded
//                     to 2 significant figures, because exact figures can be business-sensitive;
//   exact:            counts are integers, times have 3 decimals (microseconds);
//   both:             fractions (null_frac, correlation, most_common_freqs, negative n_distinct)
//                     have 4 decimals. Identifiers and configuration (attnum, block_size) are exact.
// Fixed formatting also keeps refresh diffs readable.
import { ColumnStats, Shape, Workload } from './types';

export type Precision = 'approx' | 'exact';

/** 2 significant figures: 48213551 → 48000000, 0.01234 → 0.012. */
export const sig2 = (n: number): number => (n === 0 ? 0 : Number(n.toPrecision(2)));
/** 4 decimal places, never -0. */
export const frac = (n: number): number => Math.round(n * 1e4) / 1e4 + 0;

const count = (n: number, p: Precision) => (p === 'approx' ? sig2(n) : Math.round(n));
const countOrNull = (n: number | null, p: Precision) => (n === null ? null : count(n, p));
const millis = (n: number, p: Precision) => (p === 'approx' ? sig2(n) : Math.round(n * 1000) / 1000);

function stats(s: ColumnStats, p: Precision): ColumnStats {
  return {
    inherited: s.inherited,
    null_frac: frac(s.null_frac),
    avg_width: count(s.avg_width, p),
    // Positive: an estimated count of distinct values. Negative: minus a ratio to the row count.
    n_distinct: s.n_distinct >= 0 ? count(s.n_distinct, p) : frac(s.n_distinct),
    correlation: s.correlation === null ? null : frac(s.correlation),
    mcv_freqs: s.mcv_freqs === null ? null : s.mcv_freqs.map(frac),
  };
}

export function formatShape(shape: Shape, p: Precision): Shape {
  return {
    ...shape,
    relations: shape.relations.map((r) => ({
      ...r,
      reltuples: countOrNull(r.reltuples, p),
      relpages: countOrNull(r.relpages, p),
      relallvisible: count(r.relallvisible, p),
      size_bytes: r.size_bytes && {
        table: count(r.size_bytes.table, p),
        indexes: count(r.size_bytes.indexes, p),
        total: count(r.size_bytes.total, p),
      },
      activity: r.activity && {
        n_live_tup: count(r.activity.n_live_tup, p),
        n_dead_tup: count(r.activity.n_dead_tup, p),
        seq_scan: count(r.activity.seq_scan, p),
        idx_scan: countOrNull(r.activity.idx_scan, p),
        n_tup_ins: count(r.activity.n_tup_ins, p),
        n_tup_upd: count(r.activity.n_tup_upd, p),
        n_tup_del: count(r.activity.n_tup_del, p),
      },
      columns: r.columns.map((c) => ({ ...c, stats: c.stats.map((s) => stats(s, p)) })),
    })),
    indexes: shape.indexes.map((i) => ({ ...i, size_bytes: count(i.size_bytes, p), idx_scan: countOrNull(i.idx_scan, p) })),
  };
}

export function formatWorkload(w: Workload, p: Precision): Workload {
  return {
    ...w,
    source: w.source && { ...w.source, dealloc: count(w.source.dealloc, p) },
    statements: w.statements.map((s) => ({
      ...s,
      calls: count(s.calls, p),
      total_exec_ms: millis(s.total_exec_ms, p),
      mean_exec_ms: millis(s.mean_exec_ms, p),
      rows: count(s.rows, p),
      shared_blks_hit: count(s.shared_blks_hit, p),
      shared_blks_read: count(s.shared_blks_read, p),
    })),
  };
}
