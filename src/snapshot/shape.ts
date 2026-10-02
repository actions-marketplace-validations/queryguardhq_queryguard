import { quoteIdent } from '../ident';
import { Queryable, withSavepoint } from './session';
import {
  Activity,
  ColumnShape,
  ColumnStats,
  IndexKey,
  IndexShape,
  PartialReason,
  RelationKind,
  RelationShape,
  Shape,
} from './types';

// Every query reads catalogs or cumulative-stats views only, each schema-qualified, and none
// opens a user table: no size functions and no deparsing (pg_relation_size, pg_get_indexdef and
// pg_get_expr all take AccessShareLock on the table; see docs/design/snapshot.md, V4), no ANALYZE,
// no scans. Shape mode selects only the shape columns of pg_stats; value columns never reach us.

const RELATIONS_SQL = `
SELECT c.oid::int8 AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
       c.reltuples, c.relpages, c.relallvisible,
       c.relrowsecurity AND pg_catalog.row_security_active(c.oid) AS rls_active,
       COALESCE(t.relpages, 0) + COALESCE((
         SELECT pg_catalog.sum(ti.relpages) FROM pg_catalog.pg_index tx
           JOIN pg_catalog.pg_class ti ON ti.oid = tx.indexrelid
          WHERE tx.indrelid = c.reltoastrelid), 0) AS toast_pages,
       COALESCE((
         SELECT pg_catalog.sum(ic.relpages) FROM pg_catalog.pg_index x
           JOIN pg_catalog.pg_class ic ON ic.oid = x.indexrelid
          WHERE x.indrelid = c.oid), 0) AS index_pages,
       pn.nspname AS parent_schema, pc.relname AS parent_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_class t ON t.oid = c.reltoastrelid
  LEFT JOIN pg_catalog.pg_inherits inh ON c.relispartition AND inh.inhrelid = c.oid
  LEFT JOIN pg_catalog.pg_class pc ON pc.oid = inh.inhparent
  LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
 WHERE c.relkind IN ('r', 'p', 'm', 'f')
   AND c.relpersistence <> 't'
   AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
   AND NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e')
 ORDER BY n.nspname, c.relname`;

/** Relations that belong to an extension (e.g. the pg_stat_statements view): not snapshot relations, not reported. */
const EXTENSION_RELATIONS_SQL = `
SELECT n.nspname AS schema, c.relname AS name
  FROM pg_catalog.pg_depend d
  JOIN pg_catalog.pg_class c ON c.oid = d.objid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.deptype = 'e'`;

const CONTEXT_SQL = `
SELECT pg_catalog.current_setting('block_size')::int AS block_size,
       (SELECT d.stats_reset FROM pg_catalog.pg_stat_database d
         WHERE d.datname = pg_catalog.current_database()) AS stats_reset,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'queryguard' AND p.proname = 'column_shape' AND p.pronargs = 0
            AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
            AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')) AS has_shape_function`;

const ACTIVITY_SQL = `
SELECT s.relid::int8 AS oid, s.n_live_tup, s.n_dead_tup, s.seq_scan, s.idx_scan,
       s.n_tup_ins, s.n_tup_upd, s.n_tup_del,
       GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyze
  FROM pg_catalog.pg_stat_user_tables s
 WHERE s.relid = ANY($1::oid[])`;

const INDEXES_SQL = `
SELECT x.indrelid::int8 AS table_oid, n.nspname AS schema, ic.relname AS name, ic.relkind::text AS relkind,
       am.amname AS method, x.indisunique AS is_unique, x.indisprimary AS is_primary,
       x.indisvalid AS is_valid, x.indpred IS NOT NULL AS is_partial, x.indnkeyatts AS nkeys,
       ic.relpages,
       (SELECT pg_catalog.array_agg(a.attname::text ORDER BY k.n)
          FROM pg_catalog.generate_series(1, x.indnatts) AS k(n)
          LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[k.n - 1]) AS cols,
       s.idx_scan
  FROM pg_catalog.pg_index x
  JOIN pg_catalog.pg_class ic ON ic.oid = x.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = ic.relnamespace
  JOIN pg_catalog.pg_am am ON am.oid = ic.relam
  LEFT JOIN pg_catalog.pg_stat_user_indexes s ON s.indexrelid = x.indexrelid
 WHERE x.indrelid = ANY($1::oid[])`;

const ATTRIBUTES_SQL = `
SELECT a.attrelid::int8 AS oid, a.attnum, a.attname,
       pg_catalog.has_column_privilege(a.attrelid, a.attnum, 'SELECT') AS can_read
  FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY a.attrelid, a.attnum`;

/** Shape columns only. The name filters fetch a superset; exact (schema, table) pairs are matched in code. */
const statsSql = (source: 'pg_catalog.pg_stats' | 'queryguard.column_shape()') => `
SELECT s.schemaname, s.tablename, s.attname, s.inherited,
       s.null_frac, s.avg_width, s.n_distinct, s.correlation, s.most_common_freqs
  FROM ${source} s
 WHERE s.schemaname = ANY($1::name[]) AND s.tablename = ANY($2::name[])`;

const KINDS: Record<string, RelationKind> = { r: 'table', p: 'partitioned_table', m: 'matview', f: 'foreign_table' };

/** Relations per batch. A failed batch is retried one relation at a time, so one bad relation cannot hide others. */
export const BATCH_SIZE = 100;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
export const displayName = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;

interface RelationRow {
  oid: string;
  schema: string;
  name: string;
  rls_active: boolean;
  shape: RelationShape;
}

interface BatchResult {
  activity: Map<string, { activity: Activity; last_analyze: string | null }>;
  columns: Map<string, ColumnShape[]>;
  indexes: IndexShape[];
}

export interface ShapeResult {
  shape: Shape;
  partial: PartialReason[];
  /** Extension-owned relations, for resolving workload references. Not written to the artifact. */
  extensionRelations: { schema: string; name: string }[];
}

/** Collects shape-mode data. Must run inside one read-only transaction (see `readOnly`). */
export async function collectShape(db: Queryable, serverVersionNum: number): Promise<ShapeResult> {
  // Every cumulative-stats read in this transaction then sees one consistent snapshot (15+).
  if (serverVersionNum >= 150000) await db.query(`SET LOCAL stats_fetch_consistency = 'snapshot'`);

  const ctx = (await db.query(CONTEXT_SQL)).rows[0];
  const blockSize = num(ctx.block_size);
  const statsSource = ctx.has_shape_function ? 'queryguard.column_shape()' : 'pg_catalog.pg_stats';

  const relations: RelationRow[] = (await db.query(RELATIONS_SQL)).rows.map((r) => {
    const kind = KINDS[r.relkind];
    const heap = (num(r.relpages) + num(r.toast_pages)) * blockSize;
    const indexes = num(r.index_pages) * blockSize;
    const reltuples = num(r.reltuples);
    return {
      oid: String(r.oid),
      schema: r.schema,
      name: r.name,
      rls_active: !!r.rls_active,
      shape: {
        schema: r.schema,
        name: r.name,
        kind,
        partition_of: r.parent_name ? displayName(r.parent_schema, r.parent_name) : null,
        reltuples: reltuples < 0 ? null : reltuples,
        relpages: num(r.relpages),
        relallvisible: num(r.relallvisible),
        size_bytes: kind === 'foreign_table' ? null : { table: heap, indexes, total: heap + indexes },
        activity: null,
        last_analyze: null,
        columns: [],
      },
    };
  });

  const partial: PartialReason[] = [];
  const indexes: IndexShape[] = [];
  const apply = (batch: RelationRow[], res: BatchResult) => {
    for (const rel of batch) {
      const a = res.activity.get(rel.oid);
      rel.shape.activity = a?.activity ?? null;
      rel.shape.last_analyze = a?.last_analyze ?? null;
      rel.shape.columns = res.columns.get(rel.oid) ?? [];
    }
    indexes.push(...res.indexes);
  };

  for (let i = 0; i < relations.length; i += BATCH_SIZE) {
    const batch = relations.slice(i, i + BATCH_SIZE);
    try {
      apply(batch, await withSavepoint(db, 'qg_batch', () => collectBatch(db, batch, statsSource, blockSize)));
    } catch {
      for (const rel of batch) {
        try {
          apply([rel], await withSavepoint(db, 'qg_relation', () => collectBatch(db, [rel], statsSource, blockSize)));
        } catch (err: any) {
          rel.shape.error = String(err?.message ?? err);
          partial.push({ scope: `shape:${displayName(rel.schema, rel.name)}`, reason: `collection failed: ${rel.shape.error}` });
        }
      }
    }
  }

  for (const rel of relations) {
    const hidden = rel.shape.columns.filter((c) => c.missing === 'no_privilege' || c.missing === 'hidden_by_rls');
    if (hidden.length === 0) continue;
    const why = hidden.some((c) => c.missing === 'hidden_by_rls')
      ? 'row-level security applies to this role'
      : 'no SELECT privilege on them';
    partial.push({
      scope: `shape:${displayName(rel.schema, rel.name)}`,
      reason: `column statistics hidden for ${hidden.length} of ${rel.shape.columns.length} columns: ${why}`,
    });
  }

  indexes.sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
  const extensionRelations = (await db.query(EXTENSION_RELATIONS_SQL)).rows.map((r) => ({ schema: r.schema, name: r.name }));
  return {
    extensionRelations,
    shape: {
      block_size: blockSize,
      size_source: 'relpages',
      column_stats_source: ctx.has_shape_function ? 'queryguard.column_shape' : 'pg_stats',
      stats_reset: { database: iso(ctx.stats_reset) },
      relations: relations.map((r) => r.shape),
      indexes,
    },
    partial,
  };
}

/** Activity, indexes and column statistics for a batch of relations. Builds results without touching the inputs. */
async function collectBatch(
  db: Queryable,
  batch: RelationRow[],
  statsSource: Parameters<typeof statsSql>[0],
  blockSize: number
): Promise<BatchResult> {
  const oids = batch.map((r) => r.oid);
  const byOid = new Map(batch.map((r) => [r.oid, r]));

  const activity: BatchResult['activity'] = new Map();
  for (const r of (await db.query(ACTIVITY_SQL, [oids])).rows) {
    activity.set(String(r.oid), {
      activity: {
        n_live_tup: num(r.n_live_tup),
        n_dead_tup: num(r.n_dead_tup),
        seq_scan: num(r.seq_scan),
        idx_scan: numOrNull(r.idx_scan),
        n_tup_ins: num(r.n_tup_ins),
        n_tup_upd: num(r.n_tup_upd),
        n_tup_del: num(r.n_tup_del),
      },
      last_analyze: iso(r.last_analyze),
    });
  }

  const indexes: IndexShape[] = (await db.query(INDEXES_SQL, [oids])).rows.map((r) => {
    const table = byOid.get(String(r.table_oid))!;
    // An expression key has indkey 0 and so no attribute name. Its text is filled in from schema.sql.
    const cols: (string | null)[] = r.cols ?? [];
    const nkeys = num(r.nkeys);
    return {
      schema: r.schema,
      name: r.name,
      table_schema: table.schema,
      table_name: table.name,
      kind: r.relkind === 'I' ? 'partitioned_index' : 'index',
      method: r.method,
      unique: r.is_unique,
      primary: r.is_primary,
      valid: r.is_valid,
      partial: r.is_partial,
      keys: cols.slice(0, nkeys).map((c): IndexKey => (c === null ? { expression: null } : { column: c })),
      include: cols.slice(nkeys).filter((c): c is string => c !== null),
      size_bytes: num(r.relpages) * blockSize,
      idx_scan: numOrNull(r.idx_scan),
    };
  });

  const stats = new Map<string, ColumnStats[]>();
  const key = (schema: string, table: string, column: string) => `${schema}\u0000${table}\u0000${column}`;
  const statsRows = (
    await db.query(statsSql(statsSource), [batch.map((r) => r.schema), batch.map((r) => r.name)])
  ).rows;
  for (const s of statsRows) {
    const k = key(s.schemaname, s.tablename, s.attname);
    const list = stats.get(k) ?? [];
    list.push({
      inherited: s.inherited,
      null_frac: num(s.null_frac),
      avg_width: num(s.avg_width),
      n_distinct: num(s.n_distinct),
      correlation: numOrNull(s.correlation),
      mcv_freqs: s.most_common_freqs ? (s.most_common_freqs as unknown[]).map(num) : null,
    });
    stats.set(k, list);
  }

  const columns: BatchResult['columns'] = new Map();
  for (const a of (await db.query(ATTRIBUTES_SQL, [oids])).rows) {
    const rel = byOid.get(String(a.oid))!;
    const found = (stats.get(key(rel.schema, rel.name, a.attname)) ?? []).sort(
      (x, y) => Number(x.inherited) - Number(y.inherited)
    );
    const col: ColumnShape = { name: a.attname, attnum: num(a.attnum), stats: found };
    if (found.length === 0) {
      col.missing =
        statsSource === 'pg_catalog.pg_stats' && !a.can_read
          ? 'no_privilege'
          : statsSource === 'pg_catalog.pg_stats' && rel.rls_active
            ? 'hidden_by_rls'
            : 'no_stats';
    }
    const list = columns.get(rel.oid) ?? [];
    list.push(col);
    columns.set(rel.oid, list);
  }

  return { activity, columns, indexes };
}
