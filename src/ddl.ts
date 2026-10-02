import { identValue } from './ident';

type TokType = 'word' | 'quoted' | 'string' | 'number' | 'punct';
export interface Token {
  type: TokType;
  text: string;
  start: number;
  end: number;
}

/** Minimal SQL tokenizer: enough structure to parse DDL headers without regexes over raw text. */
export function tokenize(sql: string): Token[] {
  const toks: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      toks.push({ type: c === '"' ? 'quoted' : 'string', text: sql.slice(start, i), start, end: i });
    } else if (c === '$' && /^\$[A-Za-z0-9_]*\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/)![0];
      const e = sql.indexOf(tag, i + tag.length);
      i = e === -1 ? n : e + tag.length;
      toks.push({ type: 'string', text: sql.slice(start, i), start, end: i });
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i])) i++;
      toks.push({ type: 'word', text: sql.slice(start, i), start, end: i });
    } else if (/[0-9]/.test(c)) {
      while (i < n && /[0-9.]/.test(sql[i])) i++;
      toks.push({ type: 'number', text: sql.slice(start, i), start, end: i });
    } else {
      i++;
      toks.push({ type: 'punct', text: c, start, end: i });
    }
  }
  return toks;
}

const isWord = (t: Token | undefined, kw: string) => !!t && t.type === 'word' && t.text.toUpperCase() === kw;
const isIdent = (t: Token | undefined) => !!t && (t.type === 'word' || t.type === 'quoted');

export interface QualifiedName {
  /** Exactly as written in the source, e.g. `public."Orders"`. */
  raw: string;
  /** Unquoted parts, e.g. ['public', 'Orders']. */
  parts: string[];
}

/** Reads `a`, `a.b` or `a.b.c` starting at toks[pos]; returns the name and the next token index. */
function readQualified(sql: string, toks: Token[], pos: number): { name: QualifiedName; next: number } | null {
  if (!isIdent(toks[pos])) return null;
  let end = pos;
  const parts = [identValue(toks[pos].text)];
  while (toks[end + 1]?.text === '.' && isIdent(toks[end + 2])) {
    parts.push(identValue(toks[end + 2].text));
    end += 2;
  }
  return { name: { raw: sql.slice(toks[pos].start, toks[end].end), parts }, next: end + 1 };
}

export interface CreateIndex {
  unique: boolean;
  concurrently: boolean;
  only: boolean;
  /** Character offset just after the INDEX keyword; CONCURRENTLY is spliced in here. */
  indexKeywordEnd: number;
  table?: QualifiedName;
}

export function parseCreateIndex(sql: string): CreateIndex | null {
  const t = tokenize(sql);
  let p = 0;
  if (!isWord(t[p], 'CREATE')) return null;
  p++;
  const unique = isWord(t[p], 'UNIQUE');
  if (unique) p++;
  if (!isWord(t[p], 'INDEX')) return null;
  const indexKeywordEnd = t[p].end;
  p++;
  const concurrently = isWord(t[p], 'CONCURRENTLY');
  if (concurrently) p++;
  if (isWord(t[p], 'IF') && isWord(t[p + 1], 'NOT') && isWord(t[p + 2], 'EXISTS')) p += 3;
  // Optional index name, then ON. An unnamed index goes straight to ON.
  if (!isWord(t[p], 'ON')) {
    const nm = readQualified(sql, t, p);
    if (!nm) return { unique, concurrently, only: false, indexKeywordEnd };
    p = nm.next;
  }
  if (!isWord(t[p], 'ON')) return { unique, concurrently, only: false, indexKeywordEnd };
  p++;
  const only = isWord(t[p], 'ONLY');
  if (only) p++;
  const table = readQualified(sql, t, p);
  return { unique, concurrently, only, indexKeywordEnd, table: table?.name };
}

export interface ColumnTypeChange {
  /** Column as written in the source (bare or quoted). */
  columnRaw: string;
  /** Type text as written, including any COLLATE clause. */
  typeDef: string;
  /** USING expression as written, if present. */
  using?: string;
}

export interface AlterTable {
  table: QualifiedName;
  typeChanges: ColumnTypeChange[];
}

export function parseAlterTable(sql: string): AlterTable | null {
  const t = tokenize(sql);
  let p = 0;
  if (!isWord(t[p], 'ALTER') || !isWord(t[p + 1], 'TABLE')) return null;
  p += 2;
  if (isWord(t[p], 'IF') && isWord(t[p + 1], 'EXISTS')) p += 2;
  if (isWord(t[p], 'ONLY')) p++;
  const nm = readQualified(sql, t, p);
  if (!nm) return null;
  p = nm.next;
  if (t[p]?.text === '*') p++;

  // Split the remaining tokens into actions at top-level commas.
  const actions: Token[][] = [[]];
  let depth = 0;
  for (; p < t.length; p++) {
    const tok = t[p];
    if (tok.text === '(') depth++;
    else if (tok.text === ')') depth--;
    if (tok.text === ',' && depth === 0) actions.push([]);
    else actions[actions.length - 1].push(tok);
  }

  const typeChanges: ColumnTypeChange[] = [];
  for (const a of actions) {
    let q = 0;
    if (!isWord(a[q], 'ALTER')) continue;
    q++;
    if (isWord(a[q], 'COLUMN')) q++;
    if (!isIdent(a[q])) continue;
    const columnRaw = a[q].text;
    q++;
    if (isWord(a[q], 'SET') && isWord(a[q + 1], 'DATA')) q += 2;
    if (!isWord(a[q], 'TYPE')) continue;
    q++;
    if (q >= a.length) continue;
    let usingAt = -1;
    let d = 0;
    for (let k = q; k < a.length; k++) {
      if (a[k].text === '(') d++;
      else if (a[k].text === ')') d--;
      else if (d === 0 && isWord(a[k], 'USING')) { usingAt = k; break; }
    }
    const typeEnd = usingAt === -1 ? a[a.length - 1].end : a[usingAt - 1].end;
    const change: ColumnTypeChange = { columnRaw, typeDef: sql.slice(a[q].start, typeEnd) };
    if (usingAt !== -1 && usingAt + 1 < a.length) {
      change.using = sql.slice(a[usingAt + 1].start, a[a.length - 1].end);
    }
    typeChanges.push(change);
  }
  return { table: nm.name, typeChanges };
}

/**
 * Whether a statement opens or closes an explicit transaction block.
 * `ROLLBACK TO SAVEPOINT` and the `... PREPARED` forms leave the block as it was.
 */
export function transactionControl(sql: string): 'begin' | 'end' | null {
  const t = tokenize(sql);
  const first = t[0]?.type === 'word' ? t[0].text.toUpperCase() : '';
  const second = t[1]?.type === 'word' ? t[1].text.toUpperCase() : '';
  if (first === 'BEGIN' || (first === 'START' && second === 'TRANSACTION')) return 'begin';
  if (first === 'COMMIT' || first === 'END' || first === 'ABORT') return second === 'PREPARED' ? null : 'end';
  if (first === 'ROLLBACK') return second === 'PREPARED' || second === 'TO' || second === 'SAVEPOINT' ? null : 'end';
  return null;
}
