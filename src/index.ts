#!/usr/bin/env node
import { Client } from 'pg';
import pkg from '../package.json';
import * as fs from 'fs';
import * as path from 'path';
import { Config, ExplainOutput, Finding, PlanNode, RunOutcome, SkippedItem } from './types';
import { buildMarkdownReport } from './reporter';
import { computeStatus, EXIT_CODES } from './status';
import { splitSqlStatements, splitSqlStatementsWithLines } from './splitter';

import { analyzeDDLLocks } from './locks';
import { seqScanRemediation } from './remediation';
import { findReportComment, withMarker } from './comment';
import { runSnapshot } from './snapshot/cli';
import { describeTable, loadForAction } from './snapshot/annotate';

export { splitSqlStatements, splitSqlStatementsWithLines, analyzeDDLLocks };


function getParam(flag: string, actionInputKey: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  const envKey = `INPUT_${actionInputKey.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] || fallback;
}

/** Boolean option: `--flag`, `--flag true|false`, or the INPUT_/env equivalent. */
function getBool(flag: string, actionInputKey: string, envKey: string): boolean {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) {
    const next = process.argv[idx + 1];
    return next === undefined || next.startsWith('--') ? true : next === 'true';
  }
  const inputKey = `INPUT_${actionInputKey.toUpperCase().replace(/-/g, '_')}`;
  return (process.env[envKey] || process.env[inputKey] || 'false') === 'true';
}

function resolveConfig(): Config {
  return {
    schemaPath: getParam('--schema', 'schema-path', ''),
    migrationPath: getParam('--migration', 'migration-path', ''),
    queriesPath: getParam('--queries', 'queries-path', 'test/queries.sql'),
    pgHost: process.env.PG_HOST || getParam('--host', 'pg-host', 'localhost'),
    pgPort: parseInt(process.env.PG_PORT || getParam('--port', 'pg-port', '5432'), 10),
    pgUser: process.env.PG_USER || getParam('--user', 'pg-user', 'postgres'),
    pgPass: process.env.PG_PASSWORD || getParam('--password', 'pg-password', 'postgres'),
    pgDb: process.env.PG_DATABASE || getParam('--database', 'pg-database', 'postgres'),
    mockRows: parseInt(process.env.MOCK_ROWS || getParam('--mock-rows', 'mock-rows', '2000'), 10),
    failOnSev1: (process.env.FAIL_ON_SEV1 || getParam('--fail-on-sev1', 'fail-on-sev1', 'false')) === 'true',
    githubToken: process.env.GITHUB_TOKEN || getParam('--token', 'github-token', ''),
    assumeInTransaction: getBool('--assume-in-transaction', 'assume-in-transaction', 'ASSUME_IN_TRANSACTION'),
    snapshotPath: getParam('--snapshot', 'snapshot-path', ''),
    snapshotMaxAgeDays: getParam('--snapshot-max-age-days', 'snapshot-max-age-days', '14'),
  };
}

/**
 * Annotates lock findings with production context from the snapshot. An unusable snapshot makes
 * the run INCONCLUSIVE; annotations never change a severity.
 */
function applySnapshot(config: Config, out: RunOutcome): void {
  if (!config.snapshotPath) return;
  const loaded = loadForAction(config.snapshotPath, config.snapshotMaxAgeDays);
  if (!loaded.ok) {
    out.skipped.push({ stage: 'snapshot', target: config.snapshotPath, reason: loaded.reason });
    return;
  }
  out.snapshot = loaded.context;
  for (const f of out.lockFindings) f.productionContext = describeTable(loaded.snapshot, f.targetTable ?? '');
}

async function scaffoldSyntheticData(client: Client, sampleCount: number): Promise<SkippedItem[]> {
  const skipped: SkippedItem[] = [];
  console.log(`[QueryGuard] Auto-scaffolding zero-PII synthetic rows (${sampleCount} rows/table)...`);
  await client.query(`SET session_replication_role = 'replica';`);

  try {
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    `);

    for (const row of tablesRes.rows) {
      const table = row.table_name;
      const colsRes = await client.query(`
        SELECT column_name, data_type, column_default, is_nullable, udt_name
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = $1
          AND (column_default IS NULL OR (column_default NOT LIKE 'nextval%' AND column_default NOT LIKE 'gen_random_uuid%'));
      `, [table]);

      if (colsRes.rows.length === 0) {
        skipped.push({ stage: 'synthetic-data', target: table, reason: 'no insertable columns (all defaulted); table left empty' });
        continue;
      }

      const colNames: string[] = [];
      const valGenerators: string[] = [];

      for (const col of colsRes.rows) {
        colNames.push(`"${col.column_name}"`);
        const dt = (col.data_type || '').toLowerCase();
        const udt = (col.udt_name || '').toLowerCase();

        if (dt.includes('int')) {
          valGenerators.push(`((i % 100) + 1)`);
        } else if (dt.includes('uuid') || udt.includes('uuid')) {
          valGenerators.push(`gen_random_uuid()`);
        } else if (dt.includes('json') || udt.includes('json')) {
          valGenerators.push(`'{"status":"synthetic"}'::jsonb`);
        } else if (dt.includes('numeric') || dt.includes('decimal') || dt.includes('double') || dt.includes('real')) {
          valGenerators.push(`((i % 1000) * 1.25)`);
        } else if (dt.includes('char') || dt.includes('text')) {
          valGenerators.push(`'sample_' || i || CASE WHEN i % 100 = 0 THEN 'pending' ELSE 'active' END`);
        } else if (dt.includes('timestamp') || dt.includes('date')) {
          valGenerators.push(`CURRENT_TIMESTAMP - (i || ' minutes')::interval`);
        } else if (dt.includes('bool')) {
          valGenerators.push(`(i % 2 = 0)`);
        } else {
          valGenerators.push(col.is_nullable === 'NO' ? `''` : `NULL`);
        }
      }

      const insertSql = `
        INSERT INTO "${table}" (${colNames.join(', ')})
        SELECT ${valGenerators.join(', ')}
        FROM generate_series(1, ${sampleCount}) i;
      `;

      try {
        await client.query(insertSql);
        await client.query(`ANALYZE "${table}";`);
        console.log(`[QueryGuard] Injected and analyzed ${sampleCount} rows for table '${table}'.`);
      } catch (err: any) {
        console.warn(`[QueryGuard] Warning: Failed auto-scaffolding '${table}': ${err.message}`);
        skipped.push({ stage: 'synthetic-data', target: table, reason: `could not generate rows: ${err.message}` });
      }
    }
  } finally {
    await client.query(`SET session_replication_role = 'origin';`);
  }
  return skipped;
}

async function upsertGithubComment(token: string, report: string) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return;
  }

  const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const prNumber = eventData.pull_request?.number;
  const repository = process.env.GITHUB_REPOSITORY;

  if (!prNumber || !repository) {
    return;
  }

  const commentsUrl = `https://api.github.com/repos/${repository}/issues/${prNumber}/comments`;
  const bodyWithMarker = withMarker(report);
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
      existingComment = findReportComment<{ id: number; body?: string | null }>(comments) ?? null;
    }

    if (existingComment) {
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
    }

    const postRes = await fetch(commentsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: bodyWithMarker }),
    });

    if (postRes.ok) {
      console.log('[QueryGuard] Successfully posted comment.');
    }
  } catch (err: any) {
    console.error(`[QueryGuard] API error during comment upsert: ${err.message}`);
  }
}

async function run() {
  if (process.argv[2] === 'snapshot') {
    process.exitCode = await runSnapshot(process.argv.slice(3));
    return;
  }

  const showHelp = process.argv.includes('--help') || process.argv.includes('-h');
  const isGitHubAction = !!process.env.GITHUB_ACTIONS;

  // -------------------------------------------------------------
  // USAGE / HELP SCREEN
  // -------------------------------------------------------------
  if (showHelp || (!isGitHubAction && process.argv.length <= 2)) {
    console.log(`
🛡️ QueryGuard Sentinel (v${pkg.version})
PostgreSQL migration lock linter and synthetic query-plan smoke test.

USAGE:
  # 1. Static Linter Mode (no database)
  $ npx queryguard --lint --migration <path-to-sql-file>

  # 2. Migration dry run + query-plan smoke test (Requires PostgreSQL)
  $ npx queryguard --schema <baseline.sql> --migration <new.sql> --queries <queries.sql>

  # 3. Production shape snapshot (read-only; in development)
  $ npx queryguard snapshot --help

OPTIONS:
  --lint, --lint-only    Run the static lock rules on a migration file (no database)
  --migration            Path to incoming migration file(s) to evaluate for locks
  --schema               Path to baseline schema DDL (applied without lock checks)
  --queries              Path to SQL queries (EXPLAINed on synthetic data; informational)
  --assume-in-transaction  Migration runner wraps each file in a transaction (Rails, Django);
                         flags CREATE INDEX CONCURRENTLY and runs the migration in BEGIN/COMMIT
  --mock-rows            Row count generated for synthetic simulation (default: 2000)
  --fail-on-sev1         Strict mode (true/false): exit 1 on lock hazards or a failed migration,
                         exit 2 if INCONCLUSIVE. Sequential scans never fail the build.
  --snapshot             A 'queryguard snapshot' directory: annotate lock findings with production
                         rows, size and traffic. An invalid snapshot makes the run INCONCLUSIVE.
  --snapshot-max-age-days  Warn when the snapshot is older than this (default: 14)
  --help, -h             Show this help screen

DOCUMENTATION & SANDBOX:
  https://query-guard.netlify.app/
`);
    process.exit(0);
  }

  const isLintMode = process.argv.includes('--lint') || process.argv.includes('--lint-only');
  const config = resolveConfig();

  // -------------------------------------------------------------
  // TIER 1: Zero-Dependency Static Linter (No DB connection needed)
  // -------------------------------------------------------------
  if (isLintMode) {
    const targetFile = config.migrationPath || config.schemaPath || process.argv[3];
    if (!targetFile || !fs.existsSync(targetFile)) {
      console.error('❌ [QueryGuard Lint Error] Target file not found. Provide a valid path via --migration <file>');
      process.exit(1);
    }

    const rawSql = fs.readFileSync(path.resolve(targetFile), 'utf8');
    const statements = splitSqlStatements(rawSql);
    const hazards = analyzeDDLLocks(statements, { assumeInTransaction: config.assumeInTransaction });

    if (hazards.length === 0) {
      console.log(`✅ [QueryGuard Lint] Clean: Evaluated ${statements.length} statement(s) in '${targetFile}'. Zero blocking migration locks detected.`);
      process.exit(0);
    } else {
      console.error(`\n🚨 [QueryGuard Lint] Found ${hazards.length} dangerous migration lock hazard(s) in '${targetFile}':\n`);
      for (const h of hazards) {
        console.error(`  • [${h.transactionHazard ? 'TRANSACTION' : h.lockType}] Table: '${h.targetTable}'`);
        console.error(`    Hazard: ${h.query}`);
        console.error(`    Fix:    ${h.recommendation}`);
        for (const line of h.remediation?.sql ?? []) console.error(`            ${line.replace(/\n/g, '\n            ')}`);
        for (const note of h.remediation?.notes ?? []) console.error(`    Note:   ${note}`);
        console.error('');
      }
      process.exit(1);
    }
  }

  // -------------------------------------------------------------
  // TIER 2 & 3: Runtime Gating Sentinel (Requires PostgreSQL)
  // -------------------------------------------------------------
  const client = new Client({
    host: config.pgHost,
    port: config.pgPort,
    user: config.pgUser,
    password: config.pgPass,
    database: config.pgDb,
  });

  console.log(`[QueryGuard] Connecting to database at ${config.pgHost}:${config.pgPort}/${config.pgDb}...`);
  await client.connect();

  const outcome: RunOutcome = { lockFindings: [], scanFindings: [], skipped: [] };
  try {
    await execute(client, config, outcome);
  } finally {
    await client.end();
  }
  applySnapshot(config, outcome);

  const status = computeStatus(outcome);
  const reportMarkdown = buildMarkdownReport(outcome);
  fs.writeFileSync('queryguard-report.md', reportMarkdown);
  console.log('\n' + reportMarkdown);
  console.log(`[QueryGuard] Status: ${status}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      fs.appendFileSync(summaryPath, reportMarkdown + '\n');
    } catch (err: any) {
      console.error(`[QueryGuard] Could not write job summary: ${err.message}`);
    }
  }

  if (config.githubToken) {
    await upsertGithubComment(config.githubToken, reportMarkdown);
  }

  // Advisory mode never fails the job on findings; the report still leads with the status.
  if (config.failOnSev1 && status !== 'PASS') {
    console.error(`\n[QueryGuard] CI GATING ${status === 'FAIL' ? 'FAILURE' : 'INCONCLUSIVE'}: status ${status} (exit ${EXIT_CODES[status]}).`);
  }
  process.exitCode = config.failOnSev1 ? EXIT_CODES[status] : 0;
}

/** Runs baseline, migration, synthetic data and EXPLAIN, filling `out`. Stops early on baseline/migration failure. */
async function execute(client: Client, config: Config, out: RunOutcome): Promise<void> {
  if (config.schemaPath) {
    const resolvedSchema = path.resolve(config.schemaPath);
    if (!fs.existsSync(resolvedSchema)) {
      out.skipped.push({ stage: 'baseline', target: config.schemaPath, reason: 'schema file not found; baseline state not built' });
      return;
    }
    console.log(`[QueryGuard] Applying baseline schema (no lock gating): ${resolvedSchema}`);
    for (const { sql, line } of splitSqlStatementsWithLines(fs.readFileSync(resolvedSchema, 'utf8'))) {
      try {
        await client.query(sql);
      } catch (err: any) {
        console.error(`[QueryGuard] Baseline statement failed at line ${line}: ${err.message}`);
        out.baselineFailure = { stage: 'baseline', statement: sql, line, message: err.message };
        return;
      }
    }
  }

  if (config.migrationPath) {
    const resolvedMigration = path.resolve(config.migrationPath);
    if (!fs.existsSync(resolvedMigration)) {
      out.skipped.push({ stage: 'migration', target: config.migrationPath, reason: 'migration file not found' });
      return;
    }
    console.log(`[QueryGuard] Analyzing incoming migration for locks: ${resolvedMigration}`);
    const migrationStatements = splitSqlStatementsWithLines(fs.readFileSync(resolvedMigration, 'utf8'));

    const hazards = analyzeDDLLocks(migrationStatements.map(s => s.sql), { assumeInTransaction: config.assumeInTransaction });
    out.lockFindings.push(...hazards);
    console.log(`[QueryGuard] Detected ${hazards.length} migration lock hazard(s) in incoming migration.`);

    // Runners that wrap each file in a transaction hit transaction-only errors in production,
    // so reproduce that here to surface the real Postgres error.
    if (config.assumeInTransaction) {
      out.assumedTransaction = true;
      await client.query('BEGIN');
    }
    for (const { sql, line } of migrationStatements) {
      try {
        await client.query(sql);
      } catch (err: any) {
        console.error(`[QueryGuard] Migration statement failed at line ${line}: ${err.message}`);
        out.migrationFailure = { stage: 'migration', statement: sql, line, message: err.message };
        if (config.assumeInTransaction) await client.query('ROLLBACK').catch(() => {});
        return;
      }
    }
    if (config.assumeInTransaction) await client.query('COMMIT');
  }

  out.skipped.push(...(await scaffoldSyntheticData(client, config.mockRows)));

  out.queriesEvaluatedOn = config.mockRows;

  const resolvedQueries = path.resolve(config.queriesPath);
  console.log(`[QueryGuard] Evaluating queries: ${resolvedQueries}`);
  const queryStatements = splitSqlStatementsWithLines(fs.readFileSync(resolvedQueries, 'utf8'));

  for (const { sql, line } of queryStatements) {
    try {
      const res = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`);
      const plan: ExplainOutput = res.rows[0]['QUERY PLAN'][0];

      const seqScanNodes: PlanNode[] = [];

      function walkPlan(node: PlanNode) {
        if (node['Node Type'] === 'Seq Scan' && (node['Filter'] || node['Plan Rows'] > 100)) {
          seqScanNodes.push(node);
        }
        if (node.Plans) {
          node.Plans.forEach(walkPlan);
        }
      }

      walkPlan(plan.Plan);

      if (seqScanNodes.length === 0) {
        out.scanFindings.push({
          query: sql,
          totalCost: plan.Plan['Total Cost'],
          hasSeqScan: false,
        });
      } else {
        for (const node of seqScanNodes) {
          const table = node['Relation Name'] || 'unknown';
          const remediation = await seqScanRemediation(client, node);

          out.scanFindings.push({
            query: sql,
            totalCost: plan.Plan['Total Cost'],
            hasSeqScan: true,
            targetTable: table,
            impactedRows: node['Plan Rows'],
            filterClause: node['Filter'],
            recommendation: remediation.summary,
            remediation,
          });
        }
      }
    } catch (err: any) {
      console.warn(`[QueryGuard] Warning: EXPLAIN failed on "${sql}": ${err.message}`);
      out.skipped.push({ stage: 'explain', target: sql, line, reason: err.message });
    }
  }
}

run().catch(err => {
  console.error(`[QueryGuard] Fatal execution error: ${err.message}`);
  process.exit(1);
});
