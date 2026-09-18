export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Total Cost': number;
  'Plan Rows': number;
  Plans?: PlanNode[];
  'Filter'?: string;
}

export interface ExplainOutput {
  Plan: PlanNode;
}

export interface Finding {
  query: string;
  totalCost: number;
  hasSeqScan: boolean;
  targetTable?: string;
  impactedRows?: number;
  filterClause?: string;
  recommendation?: string;
}

export interface Config {
  schemaPath: string;
  queriesPath: string;
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPass: string;
  pgDb: string;
  mockRows: number;
  failOnSev1: boolean;
  githubToken?: string;
}
