// Test infrastructure for `queryguard snapshot`: a Postgres 14-18 matrix with pg_stat_statements
// preloaded (docker-compose.test.yml), a fixture database full of canary strings, and a scanner
// that proves none of them reached the artifact.
import { Client } from 'pg';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { PG } from './harness';

const ROOT = path.resolve(__dirname, '..');
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** Postgres majors the snapshot tests run against. Override with TEST_SNAPSHOT_PG_VERSIONS=16,18. */
export const SNAPSHOT_VERSIONS: number[] = (process.env.TEST_SNAPSHOT_PG_VERSIONS || '14,15,16,17,18')
  .split(',')
  .map((s) => parseInt(s.trim(), 10));

/** pgNN listens on 54NN unless TEST_PGNN_PORT says otherwise. */
export function snapshotServer(version: number) {
  const port = parseInt(process.env[`TEST_PG${version}_PORT`] || String(5400 + version), 10);
  return { host: PG.host, port, user: PG.user, password: PG.password };
}

/** Fails loudly (never skips) if a matrix server is missing, is the wrong major, or lacks pg_stat_statements. */
export async function assertSnapshotServer(version: number): Promise<void> {
  const server = snapshotServer(version);
  const c = new Client({ ...server, database: 'postgres' });
  try {
    await c.connect();
  } catch (err: any) {
    throw new Error(
      `Postgres ${version} test server unreachable at ${server.host}:${server.port} (${err.message}). Run \`npm run test:db:up\`.`
    );
  }
  try {
    const { rows } = await c.query(
      `SELECT current_setting('server_version_num')::int / 10000 AS major, current_setting('shared_preload_libraries') AS preload`
    );
    if (rows[0].major !== version) throw new Error(`Port ${server.port} should be Postgres ${version}, got ${rows[0].major}`);
    if (!/\bpg_stat_statements\b/.test(rows[0].preload)) {
      throw new Error(`Postgres ${version} test server does not preload pg_stat_statements; recreate it with \`npm run test:db:up\``);
    }
  } finally {
    await c.end();
  }
}

/**
 * Unique strings planted wherever a careless exporter could pick them up. All lowercase
 * alphanumeric, so no encoding (JSON, SQL quoting) can disguise them.
 */
export const CANARY_CLASSES = [
  'email', // customers.email: unique per row, lands in histogram_bounds
  'name', // customers.full_name: lands in histogram_bounds
  'status', // customers.status: low cardinality, lands in most_common_vals
  'jsonb', // customers.profile: lands in most_common_vals
  'column_comment', // COMMENT ON COLUMN: schema.sql must not carry comments
  'query_literal', // literal in an executed SELECT
  'query_literal_write', // literal in an executed UPDATE
  'query_comment_inline', // /* comment */ inside an executed statement
  'query_comment_trailing', // -- comment after an executed statement
] as const;
export type CanaryClass = (typeof CANARY_CLASSES)[number];

export interface Fixture {
  version: number;
  database: string;
  role: string;
  password: string;
  canaries: Record<CanaryClass, string>;
  /** libpq environment that connects `queryguard snapshot` to the fixture as its owner (a superuser). */
  env: Record<string, string>;
  /** A connection as the fixture owner; the caller ends it. */
  connect(): Promise<Client>;
  cleanup(): Promise<void>;
}

/**
 * A fresh database and owner role on the given matrix server: PII-shaped tables seeded with
 * canaries, ANALYZEd, plus a small workload with canaries in literals and comments. Seeding
 * uses bind parameters, so the only query texts that carry canaries are the deliberate ones.
 */
export async function createFixture(version: number): Promise<Fixture> {
  const server = snapshotServer(version);
  const suffix = hex(6);
  const database = `qg_snap_${suffix}`;
  const role = `qg_owner_${suffix}`;
  const password = `qgsecret${hex(8)}`;
  const canaries = Object.fromEntries(
    CANARY_CLASSES.map((c) => [c, `qgcanary${c.replace(/_/g, '')}${hex(5)}`])
  ) as Record<CanaryClass, string>;

  const admin = new Client({ ...server, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN SUPERUSER PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
  } finally {
    await admin.end();
  }

  const connect = async () => {
    const c = new Client({ host: server.host, port: server.port, user: role, password, database });
    await c.connect();
    return c;
  };

  const cleanup = async () => {
    const a = new Client({ ...server, database: 'postgres' });
    await a.connect();
    try {
      await a.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await a.query(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await a.end();
    }
  };

  try {
    const c = await connect();
    try {
      await c.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
      await c.query(`
        CREATE TABLE customers (
          id bigserial PRIMARY KEY,
          email text NOT NULL,
          full_name text NOT NULL,
          status text NOT NULL,
          profile jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      await c.query(`CREATE UNIQUE INDEX customers_email_key ON customers (email)`);
      await c.query(`
        CREATE TABLE orders (
          id bigserial PRIMARY KEY,
          customer_id bigint NOT NULL REFERENCES customers (id),
          status text NOT NULL,
          total numeric(12, 2) NOT NULL,
          note text
        )`);
      await c.query(`CREATE INDEX orders_customer_id_idx ON orders (customer_id)`);
      // Utility statements cannot take bind parameters, so this canary is also in pg_stat_statements.
      await c.query(`COMMENT ON COLUMN customers.full_name IS 'owner note ${canaries.column_comment}'`);

      await c.query(
        `INSERT INTO customers (email, full_name, status, profile)
         SELECT $1 || i || '@example.test',
                $2 || ' ' || i,
                CASE WHEN i % 10 < 3 THEN $3 WHEN i % 10 < 8 THEN 'active' ELSE 'closed' END,
                CASE WHEN i % 10 < 4 THEN jsonb_build_object('note', $4::text) ELSE '{"note": "none"}'::jsonb END
         FROM generate_series(1, 5000) AS i`,
        [canaries.email, canaries.name, canaries.status, canaries.jsonb]
      );
      await c.query(
        `INSERT INTO orders (customer_id, status, total)
         SELECT 1 + i % 5000, CASE WHEN i % 4 = 0 THEN 'shipped' ELSE 'pending' END, (i % 500) * 1.5
         FROM generate_series(1, 20000) AS i`
      );
      await c.query(`ANALYZE customers`);
      await c.query(`ANALYZE orders`);

      // Simple-protocol texts: the server sees the literals and comments exactly as written.
      const workload = [
        `SELECT id FROM customers WHERE email = '${canaries.query_literal}'`,
        `UPDATE orders SET status = status WHERE note = '${canaries.query_literal_write}'`,
        `SELECT count(*) FROM orders /* ${canaries.query_comment_inline} */ WHERE status = 'shipped'`,
        `SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.id = 42 -- ${canaries.query_comment_trailing}`,
      ];
      for (let i = 0; i < 5; i++) for (const q of workload) await c.query(q);
    } finally {
      await c.end();
    }
  } catch (err) {
    await cleanup().catch(() => {});
    throw err;
  }

  return {
    version,
    database,
    role,
    password,
    canaries,
    env: {
      PGHOST: server.host,
      PGPORT: String(server.port),
      PGUSER: role,
      PGPASSWORD: password,
      PGDATABASE: database,
    },
    connect,
    cleanup,
  };
}

/**
 * Where each canary is visible to a superuser, so the canary test cannot pass vacuously.
 * The literal canaries have no entry: Postgres normalizes them away, which unit tests of the
 * literal detector cover instead.
 */
export async function canaryExposure(fx: Fixture): Promise<Partial<Record<CanaryClass, string>>> {
  const c = await fx.connect();
  try {
    const stats = await c.query(
      `SELECT attname, most_common_vals::text AS mcv, histogram_bounds::text AS hist
         FROM pg_stats WHERE schemaname = 'public' AND tablename = 'customers'`
    );
    const col = (name: string) => stats.rows.find((r) => r.attname === name) ?? {};
    const statements = await c.query(
      `SELECT coalesce(string_agg(query, E'\\n'), '') AS text FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`
    );
    const comment = await c.query(
      `SELECT coalesce(col_description('customers'::regclass, attnum), '') AS text
         FROM pg_attribute WHERE attrelid = 'customers'::regclass AND attname = 'full_name'`
    );
    const exposed: Partial<Record<CanaryClass, string>> = {};
    const check = (cls: CanaryClass, where: string, text: string | null | undefined) => {
      if (text && text.includes(fx.canaries[cls])) exposed[cls] = where;
    };
    check('email', 'pg_stats.histogram_bounds', col('email').hist);
    check('name', 'pg_stats.histogram_bounds', col('full_name').hist);
    check('status', 'pg_stats.most_common_vals', col('status').mcv);
    check('jsonb', 'pg_stats.most_common_vals', col('profile').mcv);
    check('column_comment', 'pg_description', comment.rows[0]?.text);
    check('query_comment_inline', 'pg_stat_statements.query', statements.rows[0].text);
    check('query_comment_trailing', 'pg_stat_statements.query', statements.rows[0].text);
    return exposed;
  } finally {
    await c.end();
  }
}

export interface Leak {
  /** Path relative to the scanned directory. */
  file: string;
  label: string;
  context: string;
}

/** Every file under `dir`, relative to it. A missing directory is an error, never an empty result. */
export function listFiles(dir: string): string[] {
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

/**
 * Finds any needle in any file under `dir`, case-insensitively. Files are read as latin1, which
 * maps bytes one to one, so an ASCII needle is found whatever the file's encoding.
 */
export function scanForNeedles(dir: string, needles: Record<string, string>): Leak[] {
  const leaks: Leak[] = [];
  for (const file of listFiles(dir)) {
    const text = fs.readFileSync(path.join(dir, file)).toString('latin1').toLowerCase();
    for (const [label, needle] of Object.entries(needles)) {
      const at = text.indexOf(needle.toLowerCase());
      if (at !== -1) leaks.push({ file, label, context: text.slice(Math.max(0, at - 40), at + needle.length + 40) });
    }
  }
  return leaks;
}

export interface SnapshotRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `queryguard snapshot <args>` from source with exactly `env` (plus PATH), nothing inherited. */
export function runSnapshotCli(args: readonly string[], env: Record<string, string>, cwd: string): SnapshotRun {
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/index.ts'), 'snapshot', ...args],
    { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }
  );
  return { exitCode: res.status, stdout: res.stdout, stderr: res.stderr };
}
