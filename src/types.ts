import type { SnapshotContext } from './snapshot/annotate';

export interface Config {
  schemaPath?: string;
  migrationPath?: string;
  queriesPath: string;
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPass: string;
  pgDb: string;
  mockRows: number;
  failOnSev1: boolean;
  githubToken: string;
  /** The migration runner wraps each file in a transaction (Rails, Django, ...). */
  assumeInTransaction: boolean;
  /** A `queryguard snapshot` directory; lock findings are annotated from it. */
  snapshotPath: string;
  /** Raw input; a snapshot older than this many days is reported as stale. */
  snapshotMaxAgeDays: string;
}

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Schema?: string;
  'Total Cost': number;
  'Plan Rows': number;
  Filter?: string;
  Plans?: PlanNode[];
}

export interface ExplainOutput {
  Plan: PlanNode;
}

export interface Finding {
  query: string;
  totalCost: number;
  hasSeqScan: boolean;
  isLockRisk?: boolean;
  lockType?: 'ACCESS EXCLUSIVE' | 'SHARE';
  /** CREATE INDEX CONCURRENTLY inside a transaction: it will fail when the migration runs. */
  transactionHazard?: boolean;
  targetTable?: string;
  impactedRows?: number;
  filterClause?: string;
  /** One-line summary of the suggested fix (no SQL). */
  recommendation?: string;
  remediation?: Remediation;
  /** Production context from the snapshot, e.g. "~48M rows · ~14 GB · 3 query shapes · ~2,100 calls/s". Informational. */
  productionContext?: string;
}

/** A suggested fix. Every entry in `sql` is complete, executable SQL. */
export interface Remediation {
  summary: string;
  sql: string[];
  notes: string[];
}

export type Status = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export type Stage = 'baseline' | 'migration' | 'synthetic-data' | 'explain' | 'snapshot';

/** A statement that failed against Postgres. */
export interface StatementError {
  stage: Stage;
  statement: string;
  /** 1-based line in the source file where the statement starts. */
  line: number;
  message: string;
}

/** Something QueryGuard could not check. Any entry makes the run INCONCLUSIVE. */
export interface SkippedItem {
  stage: Stage;
  target: string;
  reason: string;
  line?: number;
}

export interface SqlStatement {
  sql: string;
  /** 1-based line in the source file where the statement starts. */
  line: number;
}

/** Everything a run produced; the single input to status and reporting. */
export interface RunOutcome {
  lockFindings: Finding[];
  scanFindings: Finding[];
  skipped: SkippedItem[];
  /** Synthetic row count per table; set once the query section ran. */
  queriesEvaluatedOn?: number;
  /** Migration was analyzed and executed as if wrapped in a transaction. */
  assumedTransaction?: boolean;
  /** Baseline schema could not be built; the run stopped there. */
  baselineFailure?: StatementError;
  /** A migration statement failed; the run stopped there. */
  migrationFailure?: StatementError;
  /** The production snapshot the findings were annotated from, when one was given and valid. */
  snapshot?: SnapshotContext;
}
