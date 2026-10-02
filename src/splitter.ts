import { SqlStatement } from './types';

export function splitSqlStatements(sqlContent: string): string[] {
  return splitSqlStatementsWithLines(sqlContent).map(s => s.sql);
}

export function splitSqlStatementsWithLines(sqlContent: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let currentStmt = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBlockComment = false;
  let inLineComment = false;
  let dollarTag: string | null = null;

  // psql meta-commands are blanked (not removed) so reported line numbers match the file.
  const lines = sqlContent.split('\n');
  const sanitizedLines = lines.map(line => (line.trim().startsWith('\\') ? '' : line));
  const fullText = sanitizedLines.join('\n');
  const len = fullText.length;

  let stmtStart = -1;
  let lineCount = 0;
  let lineIdx = 0;
  const lineAt = (idx: number): number => {
    while (lineIdx < idx) {
      if (fullText[lineIdx] === '\n') lineCount++;
      lineIdx++;
    }
    return lineCount + 1;
  };
  const append = (text: string, idx: number) => {
    if (stmtStart < 0 && text.trim().length > 0) stmtStart = idx;
    currentStmt += text;
  };
  const flush = () => {
    const trimmed = currentStmt.trim();
    if (trimmed.length > 0) statements.push({ sql: trimmed, line: lineAt(stmtStart) });
    currentStmt = '';
    stmtStart = -1;
  };

  for (let i = 0; i < len; i++) {
    const char = fullText[i];
    const nextChar = i + 1 < len ? fullText[i + 1] : '';

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !dollarTag) {
      if (char === '-' && nextChar === '-') {
        inLineComment = true;
        i++;
        continue;
      }
      if (char === '/' && nextChar === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (char === "'" && !inDoubleQuote && !dollarTag) {
      if (inSingleQuote && nextChar === "'") {
        append("''", i);
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      append(char, i);
      continue;
    }

    if (char === '"' && !inSingleQuote && !dollarTag) {
      inDoubleQuote = !inDoubleQuote;
      append(char, i);
      continue;
    }

    if (char === '$' && !inSingleQuote && !inDoubleQuote) {
      if (dollarTag === null) {
        const tagMatch = fullText.substring(i).match(/^(\$[a-zA-Z0-9_]*\$)/);
        if (tagMatch) {
          dollarTag = tagMatch[1];
          append(dollarTag, i);
          i += dollarTag.length - 1;
          continue;
        }
      } else {
        if (fullText.substring(i).startsWith(dollarTag)) {
          append(dollarTag, i);
          i += dollarTag.length - 1;
          dollarTag = null;
          continue;
        }
      }
    }

    if (char === ';' && !inSingleQuote && !inDoubleQuote && !dollarTag) {
      flush();
      continue;
    }

    append(char, i);
  }

  flush();

  return statements;
}
