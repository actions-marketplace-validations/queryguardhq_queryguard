// Full-stats mode (--mode full, PostgreSQL 18 servers): stats.sql, a script of
// pg_restore_relation_stats / pg_restore_attribute_stats calls that reproduces production's
// planner statistics in another database. Value-bearing statistics (most_common_vals,
// histogram_bounds, ...) are read and written only for the columns on the allow-list; every other
// column gets the same shape-only fields as shape.json.
import { identValue, quoteIdent } from '../ident';
import { code, lex } from './lexer';
import { Queryable } from './session';
import { displayName } from './shape';
import { PartialReason, Shape } from './types';

export const FULL_MODE_MIN_SERVER = 180000;

export interface AllowedColumn {
  schema: string;
  table: string;
  column: string;
}

export const columnName = (c: AllowedColumn) => `${displayName(c.schema, c.table)}.${quoteIdent(c.column)}`;

/**
 * Parses an allow-list: one `schema.table.column` or `table.column` per line; `#` starts a comment;
 * identifiers follow SQL rules (unquoted folds to lower case, "Quoted" keeps case). Throws on any
 * line it cannot read, with its line number.
 */
export function parseAllowList(text: string): { parts: string[]; line: number }[] {
  const out: { parts: string[]; line: number }[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const lexed = lex(line);
    const t = code(lexed.tokens);
    const parts: string[] = [];
    let ok = !lexed.problem;
    for (let k = 0; ok && k < t.length; k++) {
      if (k % 2 === 0) {
        if (t[k].type === 'word' || t[k].type === 'quoted') parts.push(identValue(t[k].text));
        else ok = false;
      } else if (t[k].text !== '.') ok = false;
    }
    if (!ok || t.length % 2 === 0 || parts.length < 2 || parts.length > 3) problems.push(`line ${i + 1}: expected schema.table.column or table.column, got "${raw.trim()}"`);
    else out.push({ parts, line: i + 1 });
  });
  if (problems.length > 0) throw new Error(`--allow-columns: ${problems.join('; ')}`);
  return out;
}

/** Resolves allow-list entries against the snapshot. Unknown or ambiguous entries fail the run: a typo must never allow nothing, or the wrong column. */
export function resolveAllowList(entries: { parts: string[]; line: number }[], shape: Shape): AllowedColumn[] {
  const problems: string[] = [];
  const resolved = new Map<string, AllowedColumn>();
  for (const { parts, line } of entries) {
    const [table, column] = parts.slice(-2);
    const candidates = shape.relations.filter((r) => r.name === table && (parts.length === 2 || r.schema === parts[0]));
    if (candidates.length !== 1) {
      problems.push(`line ${line}: ${candidates.length === 0 ? 'no such table' : 'table name is ambiguous; qualify it with its schema'}: ${parts.join('.')}`);
      continue;
    }
    const rel = candidates[0];
    if (!rel.columns.some((c) => c.name === column)) {
      problems.push(`line ${line}: no column ${column} in ${displayName(rel.schema, rel.name)}`);
      continue;
    }
    const c = { schema: rel.schema, table: rel.name, column };
    resolved.set(JSON.stringify(c), c);
  }
  if (problems.length > 0) throw new Error(`--allow-columns: ${problems.join('; ')}`);
  return [...resolved.values()];
}

/** Every pg_stats field for one column, as Postgres's own text representation. */
export interface FullStatsRow extends AllowedColumn {
  inherited: boolean;
  fields: Record<string, string | null>;
}

/** pg_stats value fields and the argument type pg_restore_attribute_stats expects for each. */
const VALUE_FIELDS: Array<[string, string]> = [
  ['most_common_vals', 'text'],
  ['most_common_freqs', 'real[]'],
  ['histogram_bounds', 'text'],
  ['most_common_elems', 'text'],
  ['most_common_elem_freqs', 'real[]'],
  ['elem_count_histogram', 'real[]'],
  ['range_length_histogram', 'text'],
  ['range_empty_frac', 'real'],
  ['range_bounds_histogram', 'text'],
];

/**
 * Reads the full pg_stats rows of the allow-listed columns, one column at a time with an exact
 * (schema, table, column) match, so no other column's values are ever fetched. Must run inside the
 * snapshot's read-only transaction. A column whose statistics the role cannot see is reported.
 */
export async function collectFullStats(db: Queryable, columns: AllowedColumn[]): Promise<{ rows: FullStatsRow[]; partial: PartialReason[] }> {
  const rows: FullStatsRow[] = [];
  const partial: PartialReason[] = [];
  const select = VALUE_FIELDS.map(([f]) => `s.${f}::text AS ${f}`).join(', ');
  for (const c of columns) {
    const res = await db.query(
      `SELECT s.inherited, ${select}
         FROM pg_catalog.pg_stats s
        WHERE s.schemaname = $1 AND s.tablename = $2 AND s.attname = $3
        ORDER BY s.inherited`,
      [c.schema, c.table, c.column]
    );
    if (res.rows.length === 0) {
      const priv = await db.query(
        `SELECT pg_catalog.has_column_privilege(pg_catalog.format('%I.%I', $1::text, $2::text), $3::text, 'SELECT') AS can_read`,
        [c.schema, c.table, c.column]
      );
      if (!priv.rows[0].can_read) {
        partial.push({ scope: `stats:${columnName(c)}`, reason: 'full statistics are hidden: the role has no SELECT privilege on this column' });
      }
      continue;
    }
    for (const r of res.rows) {
      rows.push({ ...c, inherited: r.inherited, fields: Object.fromEntries(VALUE_FIELDS.map(([f]) => [f, r[f]])) });
    }
  }
  return { rows, partial };
}

/** A SQL string literal (standard_conforming_strings on, which stats.sql sets). */
export const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

const fmt = (n: number) => String(n);

/** `body` wrapped so that a false result from a restore function raises instead of only warning. */
function checked(call: string, what: string): string {
  let tag = 'qg';
  for (let i = 1; call.includes(`$${tag}$`) || what.includes(`$${tag}$`); i++) tag = `qg${i}`;
  return `DO $${tag}$BEGIN\nIF NOT ${call} THEN\n  RAISE EXCEPTION 'QueryGuard: statistics were not restored for %', ${quoteLiteral(what)};\nEND IF;\nEND$${tag}$;\n`;
}

function call(fn: string, args: Array<[string, string]>): string {
  return `pg_catalog.${fn}(\n${args.map(([name, value]) => `  ${quoteLiteral(name)}, ${value}`).join(',\n')}\n)`;
}

/**
 * stats.sql from the (already formatted) shape and the allow-listed full rows: one relation call
 * per relation and one attribute call per column and `inherited` value. Non-allow-listed columns
 * carry shape fields only; most_common_freqs cannot be restored without most_common_vals, so it is
 * omitted for them.
 */
export function buildStatsSql(shape: Shape, relallfrozen: Map<string, number>, full: FullStatsRow[], serverVersionNum: number): string {
  const version = `${serverVersionNum}::integer`;
  const fullByKey = new Map(full.map((r) => [JSON.stringify([r.schema, r.table, r.column, r.inherited]), r]));
  let out =
    '-- QueryGuard full-mode statistics. Apply after schema.sql, on PostgreSQL 18 or newer.\n' +
    '-- Planner statistics only; ANALYZE or autovacuum on the target replaces them.\n' +
    '-- Value statistics (most common values, histograms) are present only for the allow-listed\n' +
    '-- columns named in manifest.json; every other column carries shape fields only.\n' +
    'SET standard_conforming_strings = on;\n\n';

  for (const rel of shape.relations) {
    if (rel.error) continue;
    const relArgs: Array<[string, string]> = [
      ['version', version],
      ['schemaname', quoteLiteral(rel.schema)],
      ['relname', quoteLiteral(rel.name)],
      ['relpages', `${quoteLiteral(fmt(rel.relpages ?? -1))}::integer`],
      ['reltuples', `${quoteLiteral(fmt(rel.reltuples ?? -1))}::real`],
      ['relallvisible', `${quoteLiteral(fmt(rel.relallvisible))}::integer`],
    ];
    const frozen = relallfrozen.get(JSON.stringify([rel.schema, rel.name]));
    if (frozen !== undefined) relArgs.push(['relallfrozen', `${quoteLiteral(fmt(frozen))}::integer`]);
    out += checked(call('pg_restore_relation_stats', relArgs), displayName(rel.schema, rel.name));

    for (const col of rel.columns) {
      for (const s of col.stats) {
        const args: Array<[string, string]> = [
          ['version', version],
          ['schemaname', quoteLiteral(rel.schema)],
          ['relname', quoteLiteral(rel.name)],
          ['attname', quoteLiteral(col.name)],
          ['inherited', `${quoteLiteral(String(s.inherited))}::boolean`],
          ['null_frac', `${quoteLiteral(fmt(s.null_frac))}::real`],
          ['avg_width', `${quoteLiteral(fmt(s.avg_width))}::integer`],
          ['n_distinct', `${quoteLiteral(fmt(s.n_distinct))}::real`],
        ];
        if (s.correlation !== null) args.push(['correlation', `${quoteLiteral(fmt(s.correlation))}::real`]);
        const f = fullByKey.get(JSON.stringify([rel.schema, rel.name, col.name, s.inherited]));
        if (f) {
          for (const [field, type] of VALUE_FIELDS) {
            const v = f.fields[field];
            if (v !== null) args.push([field, `${quoteLiteral(v)}::${type}`]);
          }
        }
        out += checked(call('pg_restore_attribute_stats', args), `${displayName(rel.schema, rel.name)}.${quoteIdent(col.name)}`);
      }
    }
  }
  return out;
}

/** relallfrozen (PostgreSQL 18) for the snapshot's relations. */
export async function readRelallfrozen(db: Queryable): Promise<Map<string, number>> {
  const res = await db.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relallfrozen
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'm', 'f') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`
  );
  return new Map(res.rows.map((r) => [JSON.stringify([r.schema, r.name]), Number(r.relallfrozen)]));
}
