#!/usr/bin/env node
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
  };
}

function extractColumn(filterClause?: string): string | null {
  if (!filterClause) return null;
  const cleanFilter = filterClause.replace(/::[a-zA-Z0-9_ ]+/g, '');
  const match = cleanFilter.match(/\(?([a-zA-Z_0-9]+)\)?\s*(=|>|<|>=|<=|~~|LIKE|IN)/i);
  return match ? match[1] : null;
}

export function splitSqlStatements(sqlContent: string): string[] {
  const statements: string[] = [];
  let currentStmt = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBlockComment = false;
  let inLineComment = false;
  let dollarTag: string | null = null;

  const lines = sqlContent.split('\n');
  const sanitizedLines = lines.filter(line => !line.trim().startsWith('\\'));
  const fullText = sanitizedLines.join('\n');
  const len = fullText.length;

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
        currentStmt += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      currentStmt += char;
      continue;
    }

    if (char === '"' && !inSingleQuote && !dollarTag) {
      inDoubleQuote = !inDoubleQuote;
      currentStmt += char;
      continue;
    }

    if (char === '$' && !inSingleQuote && !inDoubleQuote) {
      if (dollarTag === null) {
        const tagMatch = fullText.substring(i).match(/^(\$[a-zA-Z0-9_]*\$)/);
        if (tagMatch) {
          dollarTag = tagMatch[1];
          currentStmt += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      } else {
        if (fullText.substring(i).startsWith(dollarTag)) {
          currentStmt += dollarTag;
          i += dollarTag.length - 1;
          dollarTag = null;
          continue;
        }
      }
    }

    if (char === ';' && !inSingleQuote && !inDoubleQuote && !dollarTag) {
      const trimmed = currentStmt.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      currentStmt = '';
      continue;
    }

    currentStmt += char;
  }

  const finalTrimmed = currentStmt.trim();
  if (finalTrimmed.length > 0) {
    statements.push(finalTrimmed);
  }

  return statements;
}

export function analyzeDDLLocks(statements: string[]): Finding[] {
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

async function scaffoldSyntheticData(client: Client, sampleCount: number) {
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

      if (colsRes.rows.length === 0) continue;

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
      }
    }
  } finally {
    await client.query(`SET session_replication_role = 'origin';`);
  }
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
    const hazards = analyzeDDLLocks(statements);

    if (hazards.length === 0) {
      console.log(`✅ [QueryGuard Lint] Clean: Evaluated ${statements.length} statement(s) in '${targetFile}'. Zero blocking migration locks detected.`);
      process.exit(0);
    } else {
      console.error(`\n🚨 [QueryGuard Lint] Found ${hazards.length} dangerous migration lock hazard(s) in '${targetFile}':\n`);
      for (const h of hazards) {
        console.error(`  • [${h.lockType}] Table: '${h.targetTable}'`);
        console.error(`    Hazard: ${h.query}`);
        console.error(`    Fix:    ${h.recommendation}\n`);
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

  try {
    if (config.schemaPath && fs.existsSync(config.schemaPath)) {
      const resolvedSchema = path.resolve(config.schemaPath);
      console.log(`[QueryGuard] Applying baseline schema (no lock gating): ${resolvedSchema}`);
      const schemaStatements = splitSqlStatements(fs.readFileSync(resolvedSchema, 'utf8'));
      for (const stmt of schemaStatements) {
        try {
          await client.query(stmt);
        } catch (err: any) {
          console.warn(`[QueryGuard] Warning: Failed executing baseline statement: "${stmt.substring(0, 40)}..." -> ${err.message}`);
        }
      }
    }

    const lockFindings: Finding[] = [];
    if (config.migrationPath && fs.existsSync(config.migrationPath)) {
      const resolvedMigration = path.resolve(config.migrationPath);
      console.log(`[QueryGuard] Analyzing incoming migration for locks: ${resolvedMigration}`);
      const migrationStatements = splitSqlStatements(fs.readFileSync(resolvedMigration, 'utf8'));
      
      const hazards = analyzeDDLLocks(migrationStatements);
      lockFindings.push(...hazards);
      console.log(`[QueryGuard] Detected ${hazards.length} migration lock hazard(s) in incoming migration.`);

      for (const stmt of migrationStatements) {
        try {
          await client.query(stmt);
        } catch (err: any) {
          console.warn(`[QueryGuard] Warning: Failed applying migration statement: "${stmt.substring(0, 40)}..." -> ${err.message}`);
        }
      }
    }

    await scaffoldSyntheticData(client, config.mockRows);

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
          if (node['Node Type'] === 'Seq Scan' && (node['Filter'] || node['Plan Rows'] > 100)) {
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
              : `CREATE INDEX CONCURRENTLY idx_${table}_scan ON ${table}(/* columns */);`;

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
