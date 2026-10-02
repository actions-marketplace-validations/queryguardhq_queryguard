import { Client } from 'pg';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

export const PG = {
  host: process.env.TEST_PG_HOST || 'localhost',
  port: parseInt(process.env.TEST_PG_PORT || '5433', 10),
  user: process.env.TEST_PG_USER || 'postgres',
  password: process.env.TEST_PG_PASSWORD || 'postgres',
};

const ROOT = path.resolve(__dirname, '..');

export function adminClient(database = 'postgres'): Client {
  return new Client({ ...PG, database });
}

/** Fails loudly (never skips) if the test Postgres is not reachable or is not v16. */
export async function assertPostgres16(): Promise<void> {
  const c = adminClient();
  try {
    await c.connect();
  } catch (err: any) {
    throw new Error(
      `Test Postgres unreachable at ${PG.host}:${PG.port} (${err.message}). Run \`npm run test:db:up\`.`
    );
  }
  try {
    const { rows } = await c.query('SHOW server_version_num');
    const major = Math.floor(parseInt(rows[0].server_version_num, 10) / 10000);
    if (major !== 16) throw new Error(`Tests require Postgres 16, got ${major}`);
  } finally {
    await c.end();
  }
}

export interface Sandbox {
  dir: string;
  database: string;
  write(name: string, sql: string): string;
  cleanup(): Promise<void>;
}

/** A fresh database plus a temp dir for SQL files and the CLI's queryguard-report.md. */
export async function createSandbox(): Promise<Sandbox> {
  const database = `qg_test_${randomBytes(6).toString('hex')}`;
  const admin = adminClient();
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-'));
  return {
    dir,
    database,
    write(name, sql) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, sql);
      return p;
    },
    async cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
      const a = adminClient();
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await a.end();
    },
  };
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Contents of queryguard-report.md, or '' if none was written. */
  report: string;
}

export interface RunOpts {
  schema?: string;
  migration?: string;
  queries: string;
  /** fail-on-sev1; strict mode when true. */
  strict?: boolean;
  extraArgs?: readonly string[];
  extraEnv?: Readonly<Record<string, string>>;
}

export function runCli(sb: Sandbox, opts: RunOpts): RunResult {
  const args = [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/index.ts')];
  if (opts.schema) args.push('--schema', opts.schema);
  if (opts.migration) args.push('--migration', opts.migration);
  args.push('--queries', opts.queries);
  args.push(...(opts.extraArgs || []));

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PG_HOST: PG.host,
    PG_PORT: String(PG.port),
    PG_USER: PG.user,
    PG_PASSWORD: PG.password,
    PG_DATABASE: sb.database,
    FAIL_ON_SEV1: opts.strict ? 'true' : 'false',
    ...opts.extraEnv,
  };
  const res = spawnSync(process.execPath, args, { cwd: sb.dir, env, encoding: 'utf8' });
  const reportPath = path.join(sb.dir, 'queryguard-report.md');
  return {
    exitCode: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    report: fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '',
  };
}

/** Matches the `Status: <X>` line that the report is required to carry (item 2). */
export function reportStatus(r: RunResult): string | null {
  const m = r.report.match(/Status:\**\s*\**(PASS|FAIL|INCONCLUSIVE)\b/);
  return m ? m[1] : null;
}
