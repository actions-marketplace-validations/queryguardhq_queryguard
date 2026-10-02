// schema.sql: checks and scrubbing for a plain-format `pg_dump --schema-only`, whether we ran
// pg_dump or the user supplied the file (--schema-from). The dump is segmented by pg_dump's own
// per-object headers ("-- Name: x; Type: TABLE; Schema: public; Owner: -"), not by re-splitting
// SQL, so function bodies and BEGIN ATOMIC blocks cannot confuse it.
import { identValue } from '../ident';
import { code, lex, Token } from './lexer';
import { IndexKey, IndexShape, PartialReason, Redactions } from './types';

const HEADER = /^-- Name: (.*); Type: (.*); Schema: (.*); Owner: (.*?)(; Tablespace: .*)?$/;

/** Object types that carry data. A dump containing any of them is not schema-only and is rejected. */
const DATA_TYPES = new Set(['TABLE DATA', 'SEQUENCE SET', 'BLOB', 'BLOB DATA', 'BLOBS', 'LARGE OBJECT', 'STATISTICS DATA']);

/**
 * Object types removed from schema.sql: connection strings and credentials (servers, user
 * mappings, subscriptions), free text (comments, security labels), role names (ACLs), and the
 * database itself (its name). pg_dump already leaves most of these out by flag.
 */
const REMOVED_TYPES = new Set([
  'SERVER',
  'USER MAPPING',
  'SUBSCRIPTION',
  'SUBSCRIPTION TABLE',
  'PUBLICATION',
  'PUBLICATION TABLE',
  'PUBLICATION TABLES IN SCHEMA',
  'COMMENT',
  'SECURITY LABEL',
  'ACL',
  'DEFAULT ACL',
  'DATABASE',
  'DATABASE PROPERTIES',
]);

/** Relation types compared against the snapshot catalog. */
const RELATION_TYPES = new Set(['TABLE', 'MATERIALIZED VIEW', 'FOREIGN TABLE']);

/** Header lines that only add noise to a diff (versions, timestamps, OIDs). */
const NOISE = /^-- (Dumped from database version|Dumped by pg_dump version|Started on|Completed on|TOC entry) /;

interface Entry {
  name: string;
  type: string;
  schema: string;
  /** The header named an owner (pg_dump without --no-owner). */
  owned: boolean;
  /** The entry's lines, header included. */
  lines: string[];
}

export type SchemaRedactions = Redactions['schema'];

export interface ProcessedDump {
  /** The scrubbed schema.sql. */
  text: string;
  redactions: SchemaRedactions;
  /** Major version of the server the dump was taken from ("-- Dumped from database version"). */
  dumpedFromMajor: number | null;
  dumpedByVersion: string | null;
  /** `schema\0name` of every table, materialized view and foreign table. */
  relations: Set<string>;
  /** Index keys from each CREATE INDEX, by `schema\0index name`. */
  indexKeys: Map<string, IndexKey[]>;
}

/** Processes a plain-format schema-only dump. Throws if it is not one. */
export function processDump(raw: string): ProcessedDump {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const dumpedFrom = lines.map((l) => /^-- Dumped from database version (\d+)/.exec(l)).find(Boolean);
  const dumpedBy = lines.map((l) => /^-- Dumped by pg_dump version (\S+)/.exec(l)).find(Boolean);

  // Segment: preamble, then one entry per header block ("--", "-- Name: ...", "--").
  const preamble: string[] = [];
  const entries: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (m && lines[i + 1] === '--') {
      // The block opens with "--", optionally followed by a verbose "-- TOC entry" line.
      const current = entries[entries.length - 1]?.lines ?? preamble;
      let back = 0;
      while (current.length - 1 - back >= 0 && /^-- TOC entry /.test(current[current.length - 1 - back])) back++;
      if (current[current.length - 1 - back] === '--') {
        current.splice(current.length - 1 - back);
        entries.push({ name: m[1], type: m[2], schema: m[3], owned: m[4] !== '-', lines: ['--', `-- Name: ${m[1]}; Type: ${m[2]}; Schema: ${m[3]}; Owner: -`] });
        continue;
      }
    }
    (entries[entries.length - 1]?.lines ?? preamble).push(lines[i]);
  }
  if (entries.length === 0 && !/^-- PostgreSQL database dump/m.test(raw)) {
    throw new Error('schema file is not a plain-format pg_dump (no "-- Name: ...; Type: ..." object headers)');
  }
  const data = entries.filter((e) => DATA_TYPES.has(e.type));
  if (data.length > 0 || /^COPY .+ FROM stdin;$/m.test(raw)) {
    const types = [...new Set(data.map((e) => e.type))].join(', ') || 'COPY';
    throw new Error(`schema file contains data (${types}); it must come from pg_dump --schema-only`);
  }

  const redactions: SchemaRedactions = {
    removed_entries: {},
    removed_lines: { owner: 0, restrict: 0, connect: 0 },
  };
  const keepLine = (line: string): boolean => {
    if (/^\\(restrict|unrestrict) /.test(line)) {
      redactions.removed_lines.restrict++;
      return false;
    }
    if (/^\\connect /.test(line)) {
      redactions.removed_lines.connect++;
      return false;
    }
    if (/^ALTER .+ OWNER TO .+;$/.test(line) || /^SET SESSION AUTHORIZATION /.test(line)) {
      redactions.removed_lines.owner++;
      return false;
    }
    return !NOISE.test(line);
  };

  const kept: Entry[] = [];
  for (const e of entries) {
    if (REMOVED_TYPES.has(e.type)) {
      redactions.removed_entries[e.type] = (redactions.removed_entries[e.type] ?? 0) + 1;
      continue;
    }
    if (e.owned) redactions.removed_lines.owner++;
    kept.push(e);
  }

  const relations = new Set<string>();
  const indexKeys = new Map<string, IndexKey[]>();
  for (const e of kept) {
    if (RELATION_TYPES.has(e.type)) relations.add(`${e.schema}\u0000${e.name}`);
    if (e.type === 'INDEX') {
      const keys = createIndexKeys(e.lines.slice(2).join('\n'));
      if (keys) indexKeys.set(`${e.schema}\u0000${e.name}`, keys);
    }
  }

  const text = [...preamble, ...kept.flatMap((e) => e.lines)].filter(keepLine).join('\n').replace(/\n{3,}/g, '\n\n');
  return {
    text: text.endsWith('\n') ? text : `${text}\n`,
    redactions,
    dumpedFromMajor: dumpedFrom ? Number(dumpedFrom[1]) : null,
    dumpedByVersion: dumpedBy ? dumpedBy[1] : null,
    relations,
    indexKeys,
  };
}

const isIdent = (t: Token | undefined) => !!t && (t.type === 'word' || t.type === 'quoted');

function closeParen(t: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < t.length; k++) {
    if (t[k].text === '(') depth++;
    else if (t[k].text === ')' && --depth === 0) return k;
  }
  return -1;
}

/**
 * Key columns and expressions of a pg_dump CREATE INDEX, e.g.
 * `CREATE INDEX i ON public.t USING btree (lower(email) text_pattern_ops, (a + b) DESC, c)`
 * → [{ expression: 'lower(email)' }, { expression: 'a + b' }, { column: 'c' }]. Null if unrecognized.
 */
export function createIndexKeys(sql: string): IndexKey[] | null {
  const t = code(lex(sql).tokens);
  let open = -1;
  for (let k = 0; k + 2 < t.length; k++) {
    if (t[k].type === 'word' && t[k].text.toUpperCase() === 'USING' && t[k + 1].type === 'word' && t[k + 2].text === '(') {
      open = k + 2;
      break;
    }
  }
  if (open < 0) return null;
  const close = closeParen(t, open);
  if (close < 0) return null;

  const elements: Token[][] = [[]];
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    if (t[k].text === '(') depth++;
    else if (t[k].text === ')') depth--;
    if (depth === 0 && t[k].text === ',') elements.push([]);
    else elements[elements.length - 1].push(t[k]);
  }

  const keys: IndexKey[] = [];
  for (const el of elements) {
    if (el.length === 0) return null;
    if (el[0].text === '(') {
      const end = closeParen(el, 0);
      if (end < 2) return null;
      keys.push({ expression: sql.slice(el[1].start, el[end - 1].end) });
      continue;
    }
    let p = 0;
    while (isIdent(el[p]) && el[p + 1]?.text === '.') p += 2;
    if (!isIdent(el[p])) return null;
    if (el[p + 1]?.text === '(') {
      const end = closeParen(el, p + 1);
      if (end < 0) return null;
      keys.push({ expression: sql.slice(el[0].start, el[end].end) });
    } else if (p === 0) {
      keys.push({ column: identValue(el[0].text) });
    } else {
      return null;
    }
  }
  return keys;
}

const key = (schema: string, name: string) => `${schema}\u0000${name}`;
const show = (k: string) => k.replace('\u0000', '.');
const list = (keys: string[]) => keys.slice(0, 10).map(show).join(', ') + (keys.length > 10 ? `, and ${keys.length - 10} more` : '');

/** schema.sql and the catalog must describe the same relations; a mismatch means DDL raced the snapshot or the file is stale. */
export function compareRelations(dump: ProcessedDump, shape: { relations: { schema: string; name: string }[] }): PartialReason[] {
  const inShape = new Set(shape.relations.map((r) => key(r.schema, r.name)));
  const onlyShape = [...inShape].filter((k) => !dump.relations.has(k)).sort();
  const onlyDump = [...dump.relations].filter((k) => !inShape.has(k)).sort();
  const reasons: PartialReason[] = [];
  if (onlyShape.length > 0) reasons.push({ scope: 'schema', reason: `schema.sql is missing ${onlyShape.length} relation(s) the catalog has: ${list(onlyShape)}` });
  if (onlyDump.length > 0) reasons.push({ scope: 'schema', reason: `schema.sql has ${onlyDump.length} relation(s) the catalog does not: ${list(onlyDump)}` });
  return reasons;
}

/**
 * Fills each `{ expression: null }` index key from the index's CREATE INDEX in schema.sql. An index
 * whose keys cannot be matched position by position keeps its nulls and is reported.
 */
export function fillIndexExpressions(dump: ProcessedDump, indexes: IndexShape[]): PartialReason[] {
  const missing: string[] = [];
  for (const index of indexes) {
    if (!index.keys.some((k) => 'expression' in k && k.expression === null)) continue;
    const parsed = dump.indexKeys.get(key(index.schema, index.name));
    const matches =
      parsed !== undefined &&
      parsed.length === index.keys.length &&
      parsed.every((p, i) => {
        const k = index.keys[i];
        return 'column' in k ? 'column' in p && p.column === k.column : 'expression' in p;
      });
    if (!matches) {
      missing.push(key(index.schema, index.name));
      continue;
    }
    index.keys = parsed!;
  }
  return missing.length === 0
    ? []
    : [{ scope: 'schema', reason: `index expression text not found in schema.sql for ${missing.length} index(es): ${list(missing)}` }];
}
