// The Action's use of a snapshot: production context for each lock finding. Annotations are
// informational; they never change a severity or the status.
import { approxBytes, approxCount, ageInDays, pgVersion, rate, windowLabel, workloadSeconds } from './display';
import { code, lex } from './lexer';
import { loadSnapshot, Snapshot } from './load';
import { displayName } from './shape';
import { identValue } from '../ident';
import { RelationShape } from './types';

export interface SnapshotContext {
  label: string;
  createdAt: string;
  ageDays: number;
  maxAgeDays: number;
  stale: boolean;
  status: 'COMPLETE' | 'PARTIAL';
  partialReasons: string[];
  server: string;
  /** What the call rates average over. */
  window: string;
}

export type LoadedForAction =
  | { ok: true; snapshot: Snapshot; context: SnapshotContext }
  | { ok: false; reason: string };

/** Loads and validates the snapshot the Action was given. Any problem is a reason to report the run INCONCLUSIVE. */
export function loadForAction(dir: string, maxAgeDaysInput: string, now: Date = new Date()): LoadedForAction {
  const maxAgeDays = Number(maxAgeDaysInput);
  if (!(maxAgeDays > 0)) return { ok: false, reason: `snapshot-max-age-days must be a positive number, got "${maxAgeDaysInput}"` };
  const loaded = loadSnapshot(dir);
  if (!loaded.ok) return { ok: false, reason: `invalid snapshot: ${loaded.errors.join('; ')}` };
  const s = loaded.snapshot;
  const ageDays = ageInDays(s.manifest.created_at, now);
  return {
    ok: true,
    snapshot: s,
    context: {
      label: s.manifest.label,
      createdAt: s.manifest.created_at,
      ageDays,
      maxAgeDays,
      stale: ageDays > maxAgeDays,
      status: s.manifest.status,
      partialReasons: s.manifest.partial_reasons.map((p) => `${p.scope}: ${p.reason}`),
      server: `PostgreSQL ${pgVersion(s.manifest.server_version_num)}`,
      window: windowLabel(s),
    },
  };
}

/** Name parts of a table as written in a migration (`orders`, `public."Orders"`), or null. */
function nameParts(raw: string): string[] | null {
  const lexed = lex(raw);
  const t = code(lexed.tokens);
  if (lexed.problem || t.length === 0 || t.length % 2 === 0) return null;
  const parts: string[] = [];
  for (let k = 0; k < t.length; k++) {
    if (k % 2 === 1) {
      if (t[k].text !== '.') return null;
    } else if (t[k].type === 'word' || t[k].type === 'quoted') {
      parts.push(identValue(t[k].text));
    } else return null;
  }
  return parts;
}

type Found = { rel: RelationShape } | { reason: string };

/** Same rules as workload resolution: qualified names match exactly; an unqualified name must be unique. */
function findRelation(s: Snapshot, raw: string): Found {
  const parts = nameParts(raw);
  if (!parts || parts.length > 3) return { reason: 'table name not recognized' };
  const [schema, name] = parts.length >= 2 ? parts.slice(-2) : [undefined, parts[0]];
  const matches = s.shape.relations.filter((r) => r.name === name && (schema === undefined || r.schema === schema));
  if (matches.length === 1) return { rel: matches[0] };
  if (matches.length > 1) return { reason: `ambiguous: ${name} exists in schemas ${matches.map((r) => r.schema).join(', ')}` };
  return { reason: 'not in the snapshot (created by this migration, or newer than the snapshot?)' };
}

/** The relation plus all its partitions, at any depth. */
function withPartitions(s: Snapshot, rel: RelationShape): RelationShape[] {
  const out = [rel];
  for (let i = 0; i < out.length; i++) {
    const parent = displayName(out[i].schema, out[i].name);
    out.push(...s.shape.relations.filter((r) => r.partition_of === parent));
  }
  return out;
}

/**
 * One line of production context for a table, e.g.
 * `~48M rows · ~14 GB · 3 query shapes · ~2,100 calls/s`. A partitioned table sums its partitions.
 */
export function describeTable(s: Snapshot, raw: string): string {
  const found = findRelation(s, raw);
  if ('reason' in found) return found.reason;
  const rel = found.rel;
  if (rel.error) return `no snapshot data: ${rel.error}`;

  const family = withPartitions(s, rel);
  const names = new Set(family.map((r) => displayName(r.schema, r.name)));
  const sized = family.filter((r) => r.size_bytes);
  const parts = [
    rel.reltuples === null ? 'rows unknown' : `${approxCount(rel.reltuples)} rows`,
    sized.length > 0 ? approxBytes(sized.reduce((n, r) => n + r.size_bytes!.total, 0)) : 'size unknown',
  ];
  if (family.length > 1) parts.push(`${family.length - 1} partitions`);

  if (!s.workload.source) {
    parts.push('no workload data');
  } else {
    const statements = s.workload.statements.filter((st) => st.relations.some((r) => names.has(r)));
    parts.push(`${statements.length} query shape${statements.length === 1 ? '' : 's'}`);
    if (statements.length > 0) {
      const calls = statements.reduce((n, st) => n + st.calls, 0);
      const seconds = workloadSeconds(s);
      parts.push(seconds ? rate(calls / seconds) : `${approxCount(calls)} calls (rate unknown)`);
    }
  }
  return parts.join(' · ');
}
