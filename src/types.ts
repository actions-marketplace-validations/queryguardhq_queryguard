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
}

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
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
  targetTable?: string;
  impactedRows?: number;
  filterClause?: string;
  recommendation?: string;
}
