import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { Config, ExplainOutput, Finding, PlanNode } from './types';
import { buildMarkdownReport } from './reporter';

const BOT_MARKER = '<!-- queryguard:blast-radius-report -->';

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
  // Strip PostgreSQL type-casts like "::text" or "::character varying"
  const cleanFilter = filterClause.replace(/::[a-zA-Z0-9_ ]+/g, '');
  // Extract column name on left-hand side of operator
  const match = cleanFilter.match(/\(?([a-zA-Z_0-9]+)\)?\s*(=|>|<|>=|<=|~~|LIKE|IN)/i);
  return match ? match[1] : null;
}

function splitSqlStatements(sqlContent: string): string[] {
  const sanitized = sqlContent
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  return sanitized
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function analyzeDDLLocks(statements: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const stmt of statements) {
    const isCreateIndex = /^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(stmt);
    const hasConcurrently = /\bCONCURRENTLY\b/i.test(stmt);

    if (isCreateIndex && !hasConcurrently) {
      const match = stmt.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s+ON\s+(?:ONLY\s+)?([a-zA-Z0-9_]+)/i);
      const indexName = match ? match[1] : 'idx_name';
      const tableName = match ? match[2] : 'target_table';

      findings.push({
        query: stmt,
        totalCost: 0,
        hasSeqScan: false,
        isLockRisk: true,
        lockType: 'SHARE',
        targetTable: tableName,
        recommendation: `Use \`CREATE INDEX CONCURRENTLY ${indexName} ON ${tableName} ...\` to prevent blocking writes.`,
      });
    }

    const isAlterColumnType = /ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+ALTER\s+COLUMN\s+([a-zA-Z0-9_]+)\s+(?:SET\s+DATA\s+)?TYPE/i.test(stmt);
    if (isAlterColumnType) {
      const match = stmt.match(/ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+ALTER\s+COLUMN\s+([a-zA-Z0-9_]+)/i);
      const tableName = match ? match[1] : 'target_table';
      const columnName = match ? match[2] : 'col_name';

      findings.push({
        query: stmt,
        totalCost: 0,
        hasSeqScan: false,
        isLockRisk: true,
        lockType: 'ACCESS EXCLUSIVE',
        targetTable: tableName,
        recommendation: `Altering \`${tableName}.${columnName}\` type rewrites table and blocks all reads/writes.`,
      });
    }
  }

  return findings;
}

async function upsertGithubComment(token: string, report: string) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    console.log('[QueryGuard] GITHUB_EVENT_PATH missing; skipping comment.');
    return;
  }

  const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const prNumber = eventData.pull_request?.number;
  const repository = process.env.GITHUB_REPOSITORY;

  if (!prNumber || !repository) {
    console.log(`[QueryGuard] Non-PR context (PR: ${prNumber}, Repo:${repository}); skipping comment.`);
    return;
  }

  const commentsUrl = `https://api.github.com/repos/${repository}/issues/${prNumber}/comments`;
  const bodyWithMarker = `${BOT_MARKER}\n${report}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'QueryGuard-CI',
  };

  try {
    const listRes = await fetch(commentsUrl, { headers });
    let existingComment = null;
    if (listRes.ok) {
      const comments = await listRes.json();
      existingComment = Array.isArray(comments)
        ? comments.find((c: any) => c.body && c.body.includes(BOT_MARKER))
        : null;
    }

    if (existingComment) {
      console.log(`[QueryGuard] Updating report comment (ID: ${existingComment.id}) in place...`);
      const updateUrl = `https://api.github.com/repos/${repository}/issues/comments/${existingComment.id}`;
      const patchRes = await fetch(updateUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body: bodyWithMarker }),
      });

      if (patchRes.ok) {
        console.log('[QueryGuard] PR comment successfully updated in place.');
        return;
      }
      console.warn(`[QueryGuard] PATCH failed (${patchRes.status}). Falling back to POST...`);
    }

    const postRes = await fetch(commentsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: bodyWithMarker }),
    });

    if (postRes.ok) {
      console.log('[QueryGuard] Successfully posted comment.');
    } else {
      const err = await postRes.text();
      console.error(`[QueryGuard] Failed posting comment: ${err}`);
    }
  } catch (err: any) {
    console.error(`[QueryGuard] API error during comment upsert: ${err.message}`);
  }
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

  console.log(`[QueryGuard] Connecting to database at ${config.pgHost}:${config.pgPort}/${config.pgDb}...`);
  await client.connect();

  try {
    const resolvedSchema = path.resolve(config.schemaPath);
    console.log(`[QueryGuard] Inspecting schema DDL: ${resolvedSchema}`);
    const ddlRaw = fs.readFileSync(resolvedSchema, 'utf8');
    const ddlStatements = splitSqlStatements(ddlRaw);

    // 1. Analyze Migration DDL Locks
    const lockFindings = analyzeDDLLocks(ddlStatements);
    console.log(`[QueryGuard] Detected ${lockFindings.length} migration lock hazard(s).`);

    // 2. Apply Schema DDL Statement-by-Statement (Allows CONCURRENTLY execution)
    for (const stmt of ddlStatements) {
      try {
        await client.query(stmt);
      } catch (err: any) {
        console.warn(`[QueryGuard] Warning: Failed applying DDL statement: "${stmt.substring(0, 40)}..." -> ${err.message}`);
      }
    }

    // 3. Evaluate SQL Query Plans
    const resolvedQueries = path.resolve(config.queriesPath);
    console.log(`[QueryGuard] Evaluating queries: ${resolvedQueries}`);
    const queryStatements = splitSqlStatements(fs.readFileSync(resolvedQueries, 'utf8'));

    const scanFindings: Finding[] = [];

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
          scanFindings.push({
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

            scanFindings.push({
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

    const allFindings = [...lockFindings, ...scanFindings];
    const reportMarkdown = buildMarkdownReport(allFindings);
    fs.writeFileSync('queryguard-report.md', reportMarkdown);
    console.log('\n' + reportMarkdown);

    if (config.githubToken) {
      await upsertGithubComment(config.githubToken, reportMarkdown);
    }

    const criticalIssues = allFindings.filter(f => f.hasSeqScan || f.isLockRisk);
    if (criticalIssues.length > 0 && config.failOnSev1) {
      console.error(`\n[QueryGuard] CI GATING FAILURE: Detected ${criticalIssues.length} critical database risk(s).`);
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
