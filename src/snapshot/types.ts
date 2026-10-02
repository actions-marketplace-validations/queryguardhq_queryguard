/** Version of the on-disk snapshot layout; bumped only for incompatible changes. */
export const FORMAT_VERSION = 1;

export type SnapshotStatus = 'COMPLETE' | 'PARTIAL';

/** Why a snapshot is PARTIAL. `scope` names the part that is missing or incomplete. */
export interface PartialReason {
  scope: string;
  reason: string;
}

export interface Manifest {
  format_version: number;
  created_at: string;
  label: string;
  server_version_num: number;
  mode: 'shape' | 'full';
  /** Full mode: the columns whose value statistics are in stats.sql. */
  allowed_columns?: string[];
  precision: 'approx' | 'exact';
  status: SnapshotStatus;
  partial_reasons: PartialReason[];
  tool_version: string;
  /** Where schema.sql came from: pg_dump run by this command, or a file given with --schema-from. */
  schema_source: { kind: 'pg_dump' | 'file'; pg_dump_version: string | null };
  /** SHA-256 of every other file in the snapshot directory. */
  files: Record<string, string>;
}

export type RelationKind = 'table' | 'partitioned_table' | 'matview' | 'foreign_table';

/** Why a column has no statistics in the snapshot. Only the first two make the snapshot PARTIAL. */
export type MissingStats =
  | 'no_privilege' // pg_stats hides columns the role cannot SELECT
  | 'hidden_by_rls' // pg_stats hides tables whose row-level security applies to the role
  | 'no_stats'; // pg_statistic has no row: never analyzed, or statistics target 0

/** Shape-mode column statistics: the skew profile only, never the values themselves. */
export interface ColumnStats {
  /** True for the row that includes child tables (inheritance parents, partitioned tables). */
  inherited: boolean;
  null_frac: number;
  avg_width: number;
  n_distinct: number;
  correlation: number | null;
  /** most_common_freqs without most_common_vals. */
  mcv_freqs: number[] | null;
}

export interface ColumnShape {
  name: string;
  attnum: number;
  stats: ColumnStats[];
  missing?: MissingStats;
}

/** Cumulative counters from pg_stat_user_tables, since `stats_reset.database`. */
export interface Activity {
  n_live_tup: number;
  n_dead_tup: number;
  seq_scan: number;
  /** Null when the table has no indexes. */
  idx_scan: number | null;
  n_tup_ins: number;
  n_tup_upd: number;
  n_tup_del: number;
}

export interface RelationShape {
  schema: string;
  name: string;
  kind: RelationKind;
  /** `schema.name` of the partitioned parent, for a partition. */
  partition_of: string | null;
  /** Null when Postgres has no estimate yet (never vacuumed or analyzed). */
  reltuples: number | null;
  /** Null when Postgres reports none (a partitioned table reports -1). */
  relpages: number | null;
  relallvisible: number;
  /** relpages × block_size; the heap includes TOAST. Null for partitioned and foreign tables, which have no storage. */
  size_bytes: { table: number; indexes: number; total: number } | null;
  activity: Activity | null;
  last_analyze: string | null;
  columns: ColumnShape[];
  /** Set when collecting this relation's details failed; activity, columns and indexes are then absent. */
  error?: string;
}

/**
 * A key column, or an expression. Expression text cannot be read from the catalog without
 * locking the table (pg_get_indexdef and pg_get_expr take AccessShareLock), so it is filled in
 * from schema.sql and is null until then.
 */
export type IndexKey = { column: string } | { expression: string | null };

export interface IndexShape {
  schema: string;
  name: string;
  table_schema: string;
  table_name: string;
  kind: 'index' | 'partitioned_index';
  method: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  /** Whether the index has a WHERE clause. The predicate itself is not exported. */
  partial: boolean;
  keys: IndexKey[];
  include: string[];
  size_bytes: number;
  idx_scan: number | null;
}

export interface Shape {
  block_size: number;
  /** Sizes are estimated from pg_class.relpages, never from pg_relation_size (which locks). */
  size_source: 'relpages';
  column_stats_source: 'pg_stats' | 'queryguard.column_shape';
  stats_reset: { database: string | null };
  relations: RelationShape[];
  indexes: IndexShape[];
}

export type WorkloadKind = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'UNKNOWN';

/** One normalized statement (one queryid), aggregated across roles. Counters cover `source.window`. */
export interface WorkloadStatement {
  queryid: string;
  kind: WorkloadKind;
  /** Normalized text with comments removed, or `[redacted: literal]` / `[redacted: unparseable]`. */
  text: string;
  redaction: 'literal' | 'unparseable' | null;
  calls: number;
  total_exec_ms: number;
  mean_exec_ms: number;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
  /** Snapshot relations the statement references (`schema.name`). */
  relations: string[];
  /** Names that did not resolve to a snapshot relation. Empty for a redacted statement, whose names are only counted. */
  unresolved: string[];
  unresolved_count: number;
  /** Which top-N list selected it. */
  selected_by: ('total_time' | 'calls')[];
}

export type WorkloadWindow = { kind: 'since_reset' } | { kind: 'sampled'; seconds: number };

export interface Workload {
  /** Null when pg_stat_statements could not be read; the manifest says why. */
  source: {
    extension_version: string;
    /** When pg_stat_statements was last reset: the start of a `since_reset` window. */
    stats_reset: string | null;
    /** Entries evicted because pg_stat_statements.max was reached. */
    dealloc: number;
    window: WorkloadWindow;
  } | null;
  selection: {
    top: number;
    /** Statements eligible for selection: plannable, touching at least one non-system relation, active in the window. */
    candidates: number;
    selected: number;
  };
  /** Present for a sampled window: entries that could not be matched across the two readings. */
  sampling?: { new_entries: number; evicted_entries: number; dealloc_during_window: number };
  statements: WorkloadStatement[];
}

/** What was withheld from the artifact, and why. Counts and queryids only, never content. */
export interface Redactions {
  schema: {
    /** Objects removed from schema.sql, by pg_dump object type (servers, user mappings, comments, ACLs...). */
    removed_entries: Record<string, number>;
    /** Lines removed inside kept objects; `owner` also counts owner names blanked in object headers. */
    removed_lines: { owner: number; restrict: number; connect: number };
  };
  workload: {
    /** pg_stat_statements entries (per role) read for this database. */
    entries_read: number;
    excluded: {
      /** Utility commands: everything except SELECT, INSERT, UPDATE, DELETE and MERGE. */
      not_dml: number;
      /** Text shown as `<insufficient privilege>`: run by another role, and the snapshot role lacks pg_read_all_stats. */
      text_hidden: number;
      /** Plannable statements that reference only system catalogs. */
      system_only: number;
      /** Plannable statements that reference no relation at all, e.g. `SELECT $1`. */
      no_relations: number;
    };
    /** Selected statements whose comments were removed. */
    comments_removed: number;
    /** Selected statements whose text was replaced, by reason. */
    redacted: { literal: string[]; unparseable: string[] };
  };
}

/** COMPLETE and PARTIAL write an artifact; FAILED writes nothing and leaves any previous snapshot alone. */
export const SNAPSHOT_EXIT = { COMPLETE: 0, FAILED: 1, PARTIAL: 2 } as const;
