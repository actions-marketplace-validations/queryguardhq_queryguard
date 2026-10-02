// A small SQL lexer for the snapshot's privacy path: deciding whether a pg_stat_statements text
// may leave production. It is deliberately separate from src/ddl.ts (whose tokenizer does not
// nest block comments or understand E'' strings) and errs on the side of "unsure": anything it
// cannot close is reported as a problem, and the caller then redacts the whole text.

export type TokenType =
  | 'word' // keyword or bare identifier
  | 'quoted' // "quoted identifier", U&"..."
  | 'string' // any string literal: '', E'', N'', B'', X'', U&'', $tag$...$tag$
  | 'number' // 42, 1.5e3, .5, 0x1F, 1_000
  | 'param' // $1
  | 'op' // any other single character
  | 'comment'; // -- line or /* nested block */

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

export interface Lexed {
  tokens: Token[];
  /** Set when the text could not be lexed with confidence (e.g. an unterminated string). */
  problem?: string;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;

export function lex(sql: string): Lexed {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  const push = (type: TokenType, start: number, end: number) => tokens.push({ type, text: sql.slice(start, end), start, end });
  const fail = (problem: string): Lexed => ({ tokens, problem });

  /** End of a quoted run starting at `open` (the quote char). Doubled quotes escape; `backslash` enables \x escapes. */
  const quoted = (open: number, q: string, backslash: boolean): number => {
    let j = open + 1;
    while (j < n) {
      const ch = sql[j];
      if (backslash && ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === q) {
        if (sql[j + 1] === q) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return -1;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      push('comment', i, end);
      i = end;
      continue;
    }

    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) return fail('unterminated block comment');
      push('comment', i, j);
      i = j;
      continue;
    }

    // Prefixed strings and identifiers: E'..', B'..', X'..', N'..', U&'..', U&"..".
    if (/[EeBbXxNn]/.test(c) && next === "'") {
      const end = quoted(i + 1, "'", c === 'E' || c === 'e');
      if (end === -1) return fail('unterminated string');
      push('string', i, end);
      i = end;
      continue;
    }
    if ((c === 'U' || c === 'u') && next === '&' && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      const q = sql[i + 2];
      const end = quoted(i + 2, q, false);
      if (end === -1) return fail(q === "'" ? 'unterminated string' : 'unterminated quoted identifier');
      push(q === "'" ? 'string' : 'quoted', i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      const end = quoted(i, "'", false);
      if (end === -1) return fail('unterminated string');
      push('string', i, end);
      i = end;
      continue;
    }
    if (c === '"') {
      const end = quoted(i, '"', false);
      if (end === -1) return fail('unterminated quoted identifier');
      push('quoted', i, end);
      i = end;
      continue;
    }

    if (c === '$') {
      if (next !== undefined && DIGIT.test(next)) {
        let j = i + 1;
        while (j < n && DIGIT.test(sql[j])) j++;
        push('param', i, j);
        i = j;
        continue;
      }
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/);
      if (!tag) return fail('unexpected $');
      const close = sql.indexOf(tag[0], i + tag[0].length);
      if (close === -1) return fail('unterminated dollar-quoted string');
      push('string', i, close + tag[0].length);
      i = close + tag[0].length;
      continue;
    }

    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j])) j++;
      push('word', i, j);
      i = j;
      continue;
    }

    if (DIGIT.test(c) || (c === '.' && next !== undefined && DIGIT.test(next))) {
      let j = i;
      if (c === '0' && next !== undefined && /[xXoObB]/.test(next)) {
        j += 2;
        while (j < n && /[0-9A-Fa-f_]/.test(sql[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(sql[j])) j++;
        if (sql[j] === '.' && sql[j + 1] !== '.') {
          j++;
          while (j < n && /[0-9_]/.test(sql[j])) j++;
        }
        if (/[eE]/.test(sql[j] ?? '') && /[0-9+-]/.test(sql[j + 1] ?? '')) {
          j += 2;
          while (j < n && DIGIT.test(sql[j])) j++;
        }
      }
      push('number', i, j);
      i = j;
      continue;
    }

    push('op', i, i + 1);
    i++;
  }
  return { tokens };
}

/** Tokens without comments. */
export const code = (tokens: Token[]) => tokens.filter((t) => t.type !== 'comment');

/** A string or numeric literal survived normalization. */
export const hasLiteral = (tokens: Token[]) => tokens.some((t) => t.type === 'string' || t.type === 'number');

/** The statement as one line: comments removed, any gap between tokens collapsed to one space. */
export function rebuild(tokens: Token[]): string {
  const kept = code(tokens);
  let out = '';
  for (let k = 0; k < kept.length; k++) {
    if (k > 0 && kept[k].start > kept[k - 1].end) out += ' ';
    out += kept[k].text;
  }
  return out;
}

export type StatementKind = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE';
const MAIN: Record<string, StatementKind> = {
  SELECT: 'SELECT',
  VALUES: 'SELECT',
  TABLE: 'SELECT',
  INSERT: 'INSERT',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  MERGE: 'MERGE',
};

const upper = (t: Token | undefined) => (t && t.type === 'word' ? t.text.toUpperCase() : '');

/**
 * The plannable statement type, or null for anything else (utility commands). Leading parentheses
 * are skipped; after WITH, the main statement is the first statement keyword outside the CTE bodies.
 */
export function statementKind(tokens: Token[]): StatementKind | null {
  const t = code(tokens);
  let p = 0;
  while (t[p]?.text === '(') p++;
  const first = upper(t[p]);
  if (first in MAIN) return MAIN[first];
  if (first !== 'WITH') return null;
  let depth = 0;
  for (let k = p + 1; k < t.length; k++) {
    if (t[k].text === '(') depth++;
    else if (t[k].text === ')') depth--;
    else if (depth === 0 && upper(t[k]) in MAIN) return MAIN[upper(t[k])];
  }
  return null;
}
