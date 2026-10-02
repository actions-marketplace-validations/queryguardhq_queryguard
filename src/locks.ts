import { parseAlterTable, parseCreateIndex, transactionControl } from './ddl';
import { suffixIdent } from './ident';
import { Finding, Remediation } from './types';

/** Postgres rejects CONCURRENTLY inside a transaction block; most runners open one per file. */
export const TRANSACTION_OPT_OUT_NOTE =
  '`CONCURRENTLY` cannot run inside a transaction block, and many runners wrap each migration in one. ' +
  'Opt this migration out: Rails: `disable_ddl_transaction!` in the migration class; ' +
  'Django: `atomic = False` on the `Migration` class (or a separate `RunSQL`-only migration). ' +
  'Otherwise keep the statement in its own file that runs outside a transaction.';

const sqlLine = (s: string) => `${s.trim().replace(/;+$/, '')};`;

function createIndexRemediation(stmt: string, indexKeywordEnd: number, only: boolean, inTransaction: boolean): Remediation {
  if (only) {
    return {
      summary: 'Build the index on each partition concurrently, then attach it',
      sql: [],
      notes: [
        '`CREATE INDEX CONCURRENTLY` is not supported on a partitioned parent. Create the parent index with `ON ONLY`, run `CREATE INDEX CONCURRENTLY` on every partition, then `ALTER INDEX ... ATTACH PARTITION`.',
      ],
    };
  }
  const fixed = `${stmt.slice(0, indexKeywordEnd)} CONCURRENTLY${stmt.slice(indexKeywordEnd)}`;
  return {
    summary: inTransaction
      ? 'Create the index CONCURRENTLY, in a migration that runs outside a transaction'
      : 'Create the index CONCURRENTLY so writes are not blocked',
    sql: [sqlLine(fixed)],
    notes: [
      ...(inTransaction ? ['This statement is currently inside a transaction, where `CONCURRENTLY` is not allowed.'] : []),
      TRANSACTION_OPT_OUT_NOTE,
    ],
  };
}

function alterTypeRemediation(table: string, column: string, typeDef: string, using?: string): Remediation {
  const next = suffixIdent(column, '_new');
  const old = suffixIdent(column, '_old');
  return {
    summary: `Stage the type change through a new nullable column instead of rewriting ${table}.${column} in place`,
    sql: [
      `ALTER TABLE ${table} ADD COLUMN ${next} ${typeDef};`,
      `UPDATE ${table} SET ${next} = ${using ?? column} WHERE ${next} IS NULL;`,
      `ALTER TABLE ${table} RENAME COLUMN ${column} TO ${old};`,
      `ALTER TABLE ${table} RENAME COLUMN ${next} TO ${column};`,
    ],
    notes: [
      'Ship in phases: (1) add the column, (2) backfill it in batches and keep it in sync from the application, (3) swap the names in a later deploy once reads and writes use the new column, then drop the old column.',
      'Re-create any defaults, NOT NULL constraints and indexes on the new column (indexes with `CREATE INDEX CONCURRENTLY`).',
    ],
  };
}

export interface AnalyzeOptions {
  /** Start inside a transaction, as runners that wrap each file in one do. */
  assumeInTransaction?: boolean;
}

export function analyzeDDLLocks(statements: string[], opts: AnalyzeOptions = {}): Finding[] {
  const findings: Finding[] = [];
  let inTransaction = !!opts.assumeInTransaction;

  for (const stmt of statements) {
    const tx = transactionControl(stmt);
    if (tx) {
      inTransaction = tx === 'begin';
      continue;
    }

    const idx = parseCreateIndex(stmt);
    if (idx && idx.concurrently && inTransaction && !idx.only) {
      const remediation: Remediation = {
        summary: 'Move this statement out of the transaction',
        sql: [sqlLine(stmt)],
        notes: [TRANSACTION_OPT_OUT_NOTE],
      };
      findings.push({
        query: stmt,
        totalCost: 0,
        hasSeqScan: false,
        transactionHazard: true,
        targetTable: idx.table?.raw ?? 'unknown',
        recommendation: remediation.summary,
        remediation,
      });
    }
    if (idx && !idx.concurrently) {
      const remediation = createIndexRemediation(stmt, idx.indexKeywordEnd, idx.only, inTransaction);
      findings.push({
        query: stmt,
        totalCost: 0,
        hasSeqScan: false,
        isLockRisk: true,
        lockType: 'SHARE',
        targetTable: idx.table?.raw ?? 'unknown',
        recommendation: remediation.summary,
        remediation,
      });
    }

    const alter = parseAlterTable(stmt);
    for (const change of alter?.typeChanges ?? []) {
      const remediation = alterTypeRemediation(alter!.table.raw, change.columnRaw, change.typeDef, change.using);
      findings.push({
        query: stmt,
        totalCost: 0,
        hasSeqScan: false,
        isLockRisk: true,
        lockType: 'ACCESS EXCLUSIVE',
        targetTable: alter!.table.raw,
        recommendation: `Altering \`${alter!.table.raw}.${change.columnRaw}\` type rewrites table and blocks all reads/writes.`,
        remediation,
      });
    }
  }

  return findings;
}
