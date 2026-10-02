import { quoteIdent } from '../ident';
import { code, hasLiteral, lex, rebuild, statementKind, StatementKind, Token } from './lexer';
import { relationRefs, Resolved } from './relations';
import { Queryable, withSavepoint } from './session';
import { byCodepoint } from './writer';
import { PartialReason, Redactions, Workload, WorkloadKind, WorkloadStatement, WorkloadWindow } from './types';

export const DEFAULT_TOP = 200;
const HIDDEN_TEXT = '<insufficient privilege>';
/** pg_stat_statements 1.9 (Postgres 14) added `toplevel` and pg_stat_statements_info. */
const MIN_EXTENSION = [1, 9];

interface Entry {
  queryid: string | null;
  query: string;
  calls: number;
  total_exec_time: number;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
}

/** One read of pg_stat_statements for the current database (top-level statements only). */
export interface Reading {
  /** Server clock at the read, in ms since the epoch. */
  at: number;
  extension_version: string;
  stats_reset: string | null;
  dealloc: number;
  entries: Entry[];
}

export type ReadResult = { ok: true; reading: Reading } | { ok: false; reason: string };

const NOT_INSTALLED =
  'pg_stat_statements is not installed in this database: run CREATE EXTENSION pg_stat_statements ' +
  '(the library must also be in shared_preload_libraries)';

/** Reads pg_stat_statements. Runs inside the caller's transaction; a failure is returned, not thrown. */
export async function readWorkload(db: Queryable): Promise<ReadResult> {
  const ext = (
    await db.query(
      `SELECT e.extversion, n.nspname FROM pg_catalog.pg_extension e
         JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'pg_stat_statements'`
    )
  ).rows[0];
  if (!ext) return { ok: false, reason: NOT_INSTALLED };
  const version = String(ext.extversion);
  const [major, minor] = version.split('.').map(Number);
  if (major < MIN_EXTENSION[0] || (major === MIN_EXTENSION[0] && minor < MIN_EXTENSION[1])) {
    return {
      ok: false,
      reason: `pg_stat_statements ${version} is older than ${MIN_EXTENSION.join('.')}: run ALTER EXTENSION pg_stat_statements UPDATE`,
    };
  }
  const schema = quoteIdent(ext.nspname);
  try {
    return await withSavepoint(db, 'qg_workload', async () => {
      const info = (
        await db.query(
          `SELECT i.dealloc, i.stats_reset, pg_catalog.now() AS now FROM ${schema}.pg_stat_statements_info i`
        )
      ).rows[0];
      const rows = (
        await db.query(
          `SELECT s.queryid::text AS queryid, s.query, s.calls, s.total_exec_time, s.rows,
                  s.shared_blks_hit, s.shared_blks_read
             FROM ${schema}.pg_stat_statements s
            WHERE s.dbid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
              AND s.toplevel`
        )
      ).rows;
      return {
        ok: true as const,
        reading: {
          at: new Date(info.now).getTime(),
          extension_version: version,
          stats_reset: info.stats_reset ? new Date(info.stats_reset).toISOString() : null,
          dealloc: Number(info.dealloc),
          entries: rows.map((r) => ({
            queryid: r.queryid,
            query: r.query ?? '',
            calls: Number(r.calls),
            total_exec_time: Number(r.total_exec_time),
            rows: Number(r.rows),
            shared_blks_hit: Number(r.shared_blks_hit),
            shared_blks_read: Number(r.shared_blks_read),
          })),
        },
      };
    });
  } catch (err: any) {
    return { ok: false, reason: `pg_stat_statements could not be read: ${err?.message ?? err}` };
  }
}

type Processed =
  | { status: 'hidden' }
  | { status: 'unparseable' }
  | { status: 'ok'; kind: StatementKind | null; literal: boolean; comments: boolean; text: string; tokens: Token[] };

/** The redaction pipeline for one text: hidden → unparseable → classify → literal check → stripped text. */
export function processText(raw: string): Processed {
  if (raw === HIDDEN_TEXT) return { status: 'hidden' };
  const lexed = lex(raw);
  if (lexed.problem) return { status: 'unparseable' };
  const tokens = code(lexed.tokens);
  return {
    status: 'ok',
    kind: statementKind(tokens),
    literal: hasLiteral(tokens),
    comments: tokens.length !== lexed.tokens.length,
    text: rebuild(lexed.tokens),
    tokens,
  };
}

interface Totals {
  calls: number;
  total_exec_time: number;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
}
const COUNTERS: (keyof Totals)[] = ['calls', 'total_exec_time', 'rows', 'shared_blks_hit', 'shared_blks_read'];
const zero = (): Totals => ({ calls: 0, total_exec_time: 0, rows: 0, shared_blks_hit: 0, shared_blks_read: 0 });

interface Group {
  queryid: string;
  totals: Totals;
  /** Per-role entries of this queryid, most calls first. */
  entries: Entry[];
}

function groupByQueryid(entries: Entry[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const e of entries) {
    if (e.queryid === null) continue;
    const g = groups.get(e.queryid) ?? { queryid: e.queryid, totals: zero(), entries: [] };
    for (const k of COUNTERS) g.totals[k] += e[k];
    g.entries.push(e);
    groups.set(e.queryid, g);
  }
  for (const g of groups.values()) g.entries.sort((a, b) => b.calls - a.calls || byCodepoint(a.query, b.query));
  return groups;
}

const byQueryid = (a: { queryid: string }, b: { queryid: string }) => {
  const x = BigInt(a.queryid);
  const y = BigInt(b.queryid);
  return x < y ? -1 : x > y ? 1 : 0;
};

export interface BuildOptions {
  top: number;
  resolve: (refs: string[][]) => Resolved;
  /** The earlier reading of a sampled window. */
  before?: Reading;
}

export interface WorkloadResult {
  workload: Workload;
  redactions: Pick<Redactions, 'workload'>;
  partial: PartialReason[];
}

export function emptyWorkload(top: number, reason: string): WorkloadResult {
  return {
    workload: { source: null, selection: { top, candidates: 0, selected: 0 }, statements: [] },
    redactions: {
      workload: {
        entries_read: 0,
        excluded: { not_dml: 0, text_hidden: 0, system_only: 0, no_relations: 0 },
        comments_removed: 0,
        redacted: { literal: [], unparseable: [] },
      },
    },
    partial: [{ scope: 'workload', reason }],
  };
}

/**
 * Turns a reading (or two, for a sampled window) into the workload section: aggregates per
 * queryid, drops utility and catalog-only statements, picks the top N by total time and by calls,
 * redacts any text that still carries a literal, and resolves referenced relations.
 */
export function buildWorkload(after: Reading, opts: BuildOptions): WorkloadResult {
  const partial: PartialReason[] = [];
  const redactions: Redactions['workload'] = {
    entries_read: after.entries.length,
    excluded: { not_dml: 0, text_hidden: 0, system_only: 0, no_relations: 0 },
    comments_removed: 0,
    redacted: { literal: [], unparseable: [] },
  };

  const groups = groupByQueryid(after.entries);
  redactions.excluded.text_hidden = after.entries.filter((e) => e.queryid === null || e.query === HIDDEN_TEXT).length;

  let sampling: Workload['sampling'];
  if (opts.before) {
    const earlier = groupByQueryid(opts.before.entries);
    let newEntries = 0;
    for (const g of groups.values()) {
      const old = earlier.get(g.queryid);
      if (!old) {
        newEntries++;
        continue;
      }
      // A counter that went down was reset during the window; keep the post-reset value.
      for (const k of COUNTERS) g.totals[k] = g.totals[k] >= old.totals[k] ? g.totals[k] - old.totals[k] : g.totals[k];
    }
    sampling = {
      new_entries: newEntries,
      evicted_entries: [...earlier.keys()].filter((q) => !groups.has(q)).length,
      dealloc_during_window: Math.max(0, after.dealloc - opts.before.dealloc),
    };
    if (after.stats_reset !== opts.before.stats_reset) {
      partial.push({
        scope: 'workload',
        reason: 'pg_stat_statements was reset during the sample window; counts after the reset are used, so they cover less than the window',
      });
    }
  }

  interface Candidate {
    group: Group;
    kind: WorkloadKind;
    redaction: WorkloadStatement['redaction'];
    text: string;
    comments: boolean;
    resolved: Resolved;
  }
  const candidates: Candidate[] = [];
  for (const g of groups.values()) {
    const processed = g.entries.map((e) => processText(e.query));
    if (processed.some((p) => p.status === 'hidden')) continue; // counted above

    // Every role's text for this queryid must pass; any doubt redacts the statement.
    const ok = processed.filter((p): p is Extract<Processed, { status: 'ok' }> => p.status === 'ok');
    if (ok.length < processed.length) {
      if (g.totals.calls > 0) {
        candidates.push({
          group: g,
          kind: 'UNKNOWN',
          redaction: 'unparseable',
          text: '[redacted: unparseable]',
          comments: false,
          resolved: { relations: [], unresolved: [], system: 0 },
        });
      }
      continue;
    }
    const main = ok[0];
    if (!main.kind) {
      redactions.excluded.not_dml++;
      continue;
    }
    const resolved = opts.resolve(relationRefs(main.tokens));
    if (resolved.relations.length === 0 && resolved.unresolved.length === 0) {
      if (resolved.system > 0) redactions.excluded.system_only++;
      else redactions.excluded.no_relations++;
      continue;
    }
    if (g.totals.calls === 0) continue; // nothing ran in the sampled window
    const literal = ok.some((p) => p.literal);
    candidates.push({
      group: g,
      kind: main.kind,
      redaction: literal ? 'literal' : null,
      text: literal ? '[redacted: literal]' : main.text,
      comments: ok.some((p) => p.comments),
      resolved,
    });
  }

  const pick = (key: keyof Totals) =>
    [...candidates]
      .sort((a, b) => b.group.totals[key] - a.group.totals[key] || byQueryid(a.group, b.group))
      .slice(0, opts.top)
      .map((c) => c.group.queryid);
  const byTime = new Set(pick('total_exec_time'));
  const byCalls = new Set(pick('calls'));

  const statements: WorkloadStatement[] = candidates
    .filter((c) => byTime.has(c.group.queryid) || byCalls.has(c.group.queryid))
    .map((c) => {
      const t = c.group.totals;
      if (c.redaction) redactions.redacted[c.redaction].push(c.group.queryid);
      if (c.comments) redactions.comments_removed++;
      return {
        queryid: c.group.queryid,
        kind: c.kind,
        text: c.text,
        redaction: c.redaction,
        calls: t.calls,
        total_exec_ms: t.total_exec_time,
        mean_exec_ms: t.calls > 0 ? t.total_exec_time / t.calls : 0,
        rows: t.rows,
        shared_blks_hit: t.shared_blks_hit,
        shared_blks_read: t.shared_blks_read,
        relations: c.resolved.relations,
        // A redacted statement's unresolved names came from text we are withholding: count them only.
        unresolved: c.redaction ? [] : c.resolved.unresolved,
        unresolved_count: c.resolved.unresolved.length,
        selected_by: [
          ...(byTime.has(c.group.queryid) ? (['total_time'] as const) : []),
          ...(byCalls.has(c.group.queryid) ? (['calls'] as const) : []),
        ],
      };
    })
    .sort(byQueryid);
  redactions.redacted.literal.sort((a, b) => byQueryid({ queryid: a }, { queryid: b }));
  redactions.redacted.unparseable.sort((a, b) => byQueryid({ queryid: a }, { queryid: b }));

  if (redactions.excluded.text_hidden > 0) {
    partial.push({
      scope: 'workload',
      reason:
        `query text hidden for ${redactions.excluded.text_hidden} pg_stat_statements entries run by other roles: ` +
        'grant pg_read_all_stats to the snapshot role',
    });
  }

  const window: WorkloadWindow = opts.before
    ? { kind: 'sampled', seconds: Math.round((after.at - opts.before.at) / 100) / 10 }
    : { kind: 'since_reset' };

  return {
    workload: {
      source: {
        extension_version: after.extension_version,
        stats_reset: after.stats_reset,
        dealloc: after.dealloc,
        window,
      },
      selection: { top: opts.top, candidates: candidates.length, selected: statements.length },
      ...(sampling ? { sampling } : {}),
      statements,
    },
    redactions: { workload: redactions },
    partial,
  };
}
