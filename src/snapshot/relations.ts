// Which relations a normalized statement reads or writes, from the snapshot lexer's tokens.
// Conservative by design: a name is claimed only in a clear table position (FROM, JOIN, UPDATE,
// INSERT/MERGE INTO, USING), CTE names are excluded, and every name is resolved against the
// snapshot's own catalog. Anything that does not resolve is reported, never guessed.
import { identValue, quoteIdent } from '../ident';
import { code, Token } from './lexer';
import { displayName } from './shape';

const upper = (t: Token | undefined) => (t && t.type === 'word' ? t.text.toUpperCase() : '');
const isIdent = (t: Token | undefined) => !!t && (t.type === 'word' || t.type === 'quoted');

/** Words that end a FROM item, so they are never read as its alias. */
const NOT_ALIAS = new Set(
  `WHERE JOIN INNER LEFT RIGHT FULL CROSS NATURAL ON USING GROUP ORDER LIMIT OFFSET FETCH FOR UNION
INTERSECT EXCEPT RETURNING SET WINDOW HAVING VALUES SELECT DEFAULT OVERRIDING TABLESAMPLE WHEN THEN
DO LATERAL OUTER INTO`.split(/\s+/)
);
/** Functions whose argument syntax uses FROM for something other than a table. */
const FROM_IN_ARGS = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY']);

/** Index just past the parenthesized group opening at `open`. */
function skipParens(t: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < t.length; k++) {
    if (t[k].text === '(') depth++;
    else if (t[k].text === ')' && --depth === 0) return k + 1;
  }
  return t.length;
}

/** Names defined by WITH clauses anywhere in the statement. */
function cteNames(t: Token[]): Set<string> {
  const names = new Set<string>();
  for (let k = 0; k < t.length; k++) {
    if (upper(t[k]) !== 'WITH') continue;
    let p = k + 1;
    if (upper(t[p]) === 'RECURSIVE') p++;
    while (isIdent(t[p])) {
      const name = identValue(t[p].text);
      p++;
      if (t[p]?.text === '(') p = skipParens(t, p);
      if (upper(t[p]) !== 'AS') break;
      names.add(name);
      p++;
      if (upper(t[p]) === 'NOT') p++;
      if (upper(t[p]) === 'MATERIALIZED') p++;
      if (t[p]?.text !== '(') break;
      p = skipParens(t, p);
      // SEARCH / CYCLE clauses run until the next CTE or the main statement.
      while (p < t.length && t[p].text !== ',' && t[p].text !== '(' && !['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'TABLE'].includes(upper(t[p]))) {
        p++;
      }
      if (t[p]?.text !== ',') break;
      p++;
    }
  }
  return names;
}

/**
 * Reads one FROM item starting at `p`: an optional ONLY/LATERAL, then a relation name, a subquery
 * (skipped) or, where `functions` allows, a function call (skipped), then an optional alias.
 * INSERT/MERGE INTO and UPDATE targets cannot be functions: a parenthesis after them is a column list.
 * Returns the index after the item.
 */
function readItem(t: Token[], p: number, out: string[][], functions: boolean): number {
  while (upper(t[p]) === 'ONLY' || upper(t[p]) === 'LATERAL') p++;
  if (t[p]?.text === '(') {
    p = skipParens(t, p);
  } else if (isIdent(t[p])) {
    const parts = [identValue(t[p].text)];
    p++;
    while (t[p]?.text === '.' && isIdent(t[p + 1])) {
      parts.push(identValue(t[p + 1].text));
      p += 2;
    }
    if (functions && t[p]?.text === '(') {
      p = skipParens(t, p); // a function such as generate_series(...)
    } else {
      out.push(parts);
      if (t[p]?.text === '*') p++;
    }
  } else {
    return p;
  }
  if (upper(t[p]) === 'AS') p++;
  if (t[p]?.type === 'quoted' || (t[p]?.type === 'word' && !NOT_ALIAS.has(upper(t[p])))) {
    p++;
    if (t[p]?.text === '(') p = skipParens(t, p);
  }
  return p;
}

/** Relation names referenced by a statement, as unquoted name parts. CTE names are left out. */
export function relationRefs(tokens: Token[]): string[][] {
  const t = code(tokens);
  const ctes = cteNames(t);
  const refs: string[][] = [];
  const openers: string[] = []; // the word before each open parenthesis

  for (let k = 0; k < t.length; k++) {
    const tok = t[k];
    if (tok.text === '(') {
      openers.push(upper(t[k - 1]));
      continue;
    }
    if (tok.text === ')') {
      openers.pop();
      continue;
    }
    const enclosing = openers[openers.length - 1] ?? '';
    const word = upper(tok);
    const prev = upper(t[k - 1]);
    let list = false;
    let functions = false;
    let start = -1;

    if (word === 'FROM' && prev !== 'DISTINCT' && !FROM_IN_ARGS.has(enclosing)) {
      start = k + 1;
      list = functions = true;
    } else if (word === 'JOIN') {
      start = k + 1;
      functions = true;
    } else if (word === 'INTO' && (prev === 'INSERT' || prev === 'MERGE')) {
      start = k + 1;
    } else if (word === 'UPDATE' && !['FOR', 'KEY', 'DO'].includes(prev) && upper(t[k + 1]) !== 'SET') {
      start = k + 1;
    } else if (word === 'USING' && t[k + 1]?.text !== '(') {
      start = k + 1;
      list = functions = true;
    } else if (word === 'TABLE' && k === 0) {
      start = k + 1;
    }
    if (start < 0) continue;

    let p = readItem(t, start, refs, functions);
    while (list && t[p]?.text === ',') p = readItem(t, p + 1, refs, functions);
  }
  return refs.filter((parts) => !(parts.length === 1 && ctes.has(parts[0])));
}

export interface Resolved {
  /** `schema.name` of each relation found in the snapshot, sorted, unique. */
  relations: string[];
  /** Names that match no snapshot relation, or more than one (ambiguous). Sorted, unique. */
  unresolved: string[];
  /** References to system catalogs, which are not part of the snapshot and not reported. */
  system: number;
}

/**
 * Resolves references against the snapshot's relations. A qualified name must match exactly. An
 * unqualified name resolves only if exactly one schema has a relation of that name; otherwise it
 * is unresolved. System catalogs (pg_catalog, information_schema, unqualified pg_*) and the
 * `system` relations (those owned by extensions) are counted, not reported.
 */
export function makeResolver(
  relations: ReadonlyArray<{ schema: string; name: string }>,
  systemRelations: ReadonlyArray<{ schema: string; name: string }> = []
) {
  const exact = new Set(relations.map((r) => `${r.schema}\u0000${r.name}`));
  const sysExact = new Set(systemRelations.map((r) => `${r.schema}\u0000${r.name}`));
  const sysNames = new Set(systemRelations.map((r) => r.name));
  const byName = new Map<string, string[]>();
  for (const r of relations) byName.set(r.name, [...(byName.get(r.name) ?? []), r.schema]);

  return (refs: string[][]): Resolved => {
    const relationsOut = new Set<string>();
    const unresolved = new Set<string>();
    let system = 0;
    for (const parts of refs) {
      const [schema, name] = parts.length >= 2 ? parts.slice(-2) : [undefined, parts[0]];
      if (schema !== undefined) {
        if (exact.has(`${schema}\u0000${name}`)) relationsOut.add(displayName(schema, name));
        else if (schema === 'pg_catalog' || schema === 'information_schema' || sysExact.has(`${schema}\u0000${name}`)) system++;
        else unresolved.add(displayName(schema, name));
        continue;
      }
      const schemas = byName.get(name) ?? [];
      if (schemas.length === 1) relationsOut.add(displayName(schemas[0], name));
      else if (schemas.length === 0 && (name.startsWith('pg_') || sysNames.has(name))) system++;
      else unresolved.add(quoteIdent(name));
    }
    return { relations: [...relationsOut].sort(), unresolved: [...unresolved].sort(), system };
  };
}
