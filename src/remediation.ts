import type { Client } from 'pg';
import { indexNameFor, qualifiedName, quoteIdent } from './ident';
import { PlanNode, Remediation } from './types';

/** First column compared in an EXPLAIN filter, quoted or bare; null if none is recognizable. */
export function extractColumn(filterClause?: string): string | null {
  if (!filterClause) return null;
  const clean = filterClause.replace(/::[a-zA-Z0-9_ ]+/g, '');
  const m = clean.match(/\(?("(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_]*)\)?\s*(=|>|<|>=|<=|~~|LIKE|IN)/i);
  if (!m) return null;
  return m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1];
}

async function columnExists(client: Client, schema: string, table: string, column: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, table, column]
  );
  return res.rows.length > 0;
}

/**
 * Index suggestion for a sequential scan. Emits SQL only when the column is confirmed
 * against the catalog, so everything we print is executable.
 */
export async function seqScanRemediation(client: Client, node: PlanNode): Promise<Remediation> {
  const table = node['Relation Name'];
  const schema = node['Schema'] || 'public';
  const col = extractColumn(node['Filter']);
  if (!table || !col || !(await columnExists(client, schema, table, col))) {
    return {
      summary: `Consider an index supporting the filter on ${table ?? 'this table'}; the filtered column could not be determined automatically`,
      sql: [],
      notes: [],
    };
  }
  const target = qualifiedName(schema, table);
  return {
    summary: `Consider an index on ${table}(${col})`,
    sql: [`CREATE INDEX CONCURRENTLY ${quoteIdent(indexNameFor(table, col))} ON ${target} (${quoteIdent(col)});`],
    notes: [],
  };
}
