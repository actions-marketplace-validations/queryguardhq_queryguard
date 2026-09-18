import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { Config, ExplainOutput, Finding, PlanNode } from './types';
import { buildMarkdownReport } from './reporter';

function getParam(flag: string, actionInputKey: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  const envKey = `INPUT_${actionInputKey.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] || fallback;
}

function resolveConfig(): Config {
  return {
    schemaPath: getParam('--schema', 'schema-path', 'test/schema.sql'),
    queriesPath: getParam('--queries', 'queries-path', 'test/queries.sql'),
    pgHost: process.env.PG_HOST || getParam('--host', 'pg-host', 'localhost'),
    pgPort: parseInt(process.env.PG_PORT || getParam('--port', 'pg-port', '5432'), 10),
    pgUser: process.env.PG_USER || getParam('--user', 'pg-user', 'postgres'),
    pgPass: process.env.PG_PASSWORD || getParam('--password', 'pg-password', 'postgres'),
    pgDb: process.env.PG_DATABASE || getParam('--database', 'pg-database', 'postgres'),
    mockRows: parseInt(process.env.MOCK_ROWS || getParam('--mock-rows', 'mock-rows', '500000'), 10),
    failOnSev1: (process.env.FAIL_ON_SEV1 || getParam('--fail-on-sev1', 'fail-on-sev1', 'false')) === 'true',
    githubToken: process.env.GITHUB_TOKEN || getParam('--token', 'github-token', ''),
  };
}

function extractColumn(filterClause?: string): string | null {
  if (!filterClause) return null;
  // Matches patterns like "(organization_id = 42)" or "(created_at > ...)"
  const match = filterClause.match(/\(?([a-zA-Z_0-9]+)\s*(=|>|<|>=|<=|~~|LIKE|IN)/i);
  return match ? match[1] : null;
}

async function run() {
  const config = resolveConfig();
  const client = new Client({
    host: config.pgHost,
    port: config.pgPort,
    user: config.pgUser,
    password: config.pgPass,
    database: config.pgDb,
  });

  console.log(`[QueryGuard] Connecting to ${config.pgHost}:${config.pgPort}/${config.pgDb}...`);
  await client.connect();

  try {
    const resolvedSchema = path.resolve(config.schemaPath);
    console.log(`[QueryGuard] Applying schema: ${resolvedSchema}`);
    const ddl = fs.readFileSync(resolvedSchema, 'utf8');
    await client.query(ddl);

    const resolvedQueries = path.resolve(config.queriesPath);
    console.log(`[QueryGuard] Evaluating queries: ${resolvedQueries}`);
    const queryStatements = fs.readFileSync(resolvedQueries, 'utf8')
      .split(';')
      .map(q => q.trim())
      .filter(q => q.length > 0 && !q.startsWith('--'));

    const findings: Finding[] = [];

    for (const sql of queryStatements) {
      try {
        const res = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`);
        const plan: ExplainOutput = res.rows[0]['QUERY PLAN'][0];

        const seqScanNodes: PlanNode[] = [];

        function walkPlan(node: PlanNode) {
          if (node['Node Type'] === 'Seq Scan' && (node['Filter'] || node['Plan Rows'] > 1000)) {
            seqScanNodes.push(node);
          }
          if (node.Plans) {
            node.Plans.forEach(walkPlan);
          }
        }

        walkPlan(plan.Plan);

        if (seqScanNodes.length === 0) {
          findings.push({
            query: sql,
            totalCost: plan.Plan['Total Cost'],
            hasSeqScan: false,
          });
        } else {
          for (const node of seqScanNodes) {
            const table = node['Relation Name'] || 'unknown';
            const col = extractColumn(node['Filter']);
            const indexSql = col 
              ? `CREATE INDEX CONCURRENTLY idx_${table}_${col} ON ${table}(${col});`
              : `CREATE INDEX CONCURRENTLY idx_${table}_scan ON${table}(/* columns */);`;

            findings.push({
              query: sql,
              totalCost: plan.Plan['Total Cost'],
              hasSeqScan: true,
              targetTable: table,
              impactedRows: node['Plan Rows'],
              filterClause: node['Filter'],
              recommendation: indexSql,
            });
          }
        }
      } catch (err: any) {
        console.warn(`[QueryGuard] Warning: Query execution error on "${sql}": ${err.message}`);
      }
    }

    const reportMarkdown = buildMarkdownReport(findings);
    fs.writeFileSync('queryguard-report.md', reportMarkdown);
    console.log('\n' + reportMarkdown);

    const severeCount = findings.filter(f => f.hasSeqScan).length;
    if (severeCount > 0 && config.failOnSev1) {
      console.error(`\n[QueryGuard] Blocked: Found ${severeCount} unindexed query patterns.`);
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

run().catch(err => {
  console.error(`[QueryGuard] Fatal execution error: ${err.message}`);
  process.exit(1);
});
