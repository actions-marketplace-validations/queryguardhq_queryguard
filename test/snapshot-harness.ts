// Test infrastructure for `queryguard snapshot`: a Postgres 14-18 matrix with pg_stat_statements
// preloaded (docker-compose.test.yml), a fixture database full of canary strings, and a scanner
// that proves none of them reached the artifact.
import { Client, ClientConfig } from 'pg';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { PG } from './harness';
import { pgDumpVersion } from '../src/snapshot/pgdump';

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
  /** Connection settings for the fixture database, as its owner or as another role. */
  config(login?: { role: string; password: string }): ClientConfig;
  /** A LOGIN role with no privileges beyond PUBLIC's, dropped by cleanup(). */
  createRole(): Promise<{ role: string; password: string }>;
  cleanup(): Promise<void>;
}

/**
 * The shape function from docs/design/snapshot.md ("Minimal-grants recipe"): lets a role read the
 * skew profile in pg_stats without SELECT on any table. Run as the owner of the tables.
 */
export function shapeFunctionSql(grantee: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS queryguard`,
    `CREATE FUNCTION queryguard.column_shape()
  RETURNS TABLE (schemaname name, tablename name, attname name, inherited bool,
                 null_frac real, avg_width int, n_distinct real, correlation real,
                 most_common_freqs real[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT schemaname, tablename, attname, inherited, null_frac, avg_width,
           n_distinct, correlation, most_common_freqs
    FROM pg_catalog.pg_stats
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema') $$`,
    `REVOKE ALL ON FUNCTION queryguard.column_shape() FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA queryguard TO ${grantee}`,
    `GRANT EXECUTE ON FUNCTION queryguard.column_shape() TO ${grantee}`,
  ];
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

  const config = (login = { role, password }): ClientConfig => ({
    host: server.host,
    port: server.port,
    user: login.role,
    password: login.password,
    database,
  });
  const connect = async () => {
    const c = new Client(config());
    await c.connect();
    return c;
  };

  const extraRoles: string[] = [];
  const createRole = async () => {
    const login = { role: `qg_role_${hex(6)}`, password: `qgsecret${hex(8)}` };
    const c = await connect();
    try {
      await c.query(`CREATE ROLE ${login.role} LOGIN PASSWORD '${login.password}'`);
      extraRoles.push(login.role);
    } finally {
      await c.end();
    }
    return login;
  };

  const cleanup = async () => {
    // Free this database's pg_stat_statements entries, which would otherwise outlive it and
    // crowd the shared table for every later test.
    try {
      const own = await connect();
      try {
        await own.query(`SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname = current_database()), 0)`);
      } finally {
        await own.end();
      }
    } catch {
      // the database may never have been fully created
    }
    const a = new Client({ ...server, database: 'postgres' });
    await a.connect();
    try {
      await a.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      for (const r of [...extraRoles, role]) await a.query(`DROP ROLE IF EXISTS ${r}`);
    } finally {
      await a.end();
    }
  };

  try {
    const c = await connect();
    try {
      await c.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
      // pg_stat_statements is shared by the whole server and outlives dropped databases. Keep only
      // the entries of live test databases, so repeated runs never fill it and force evictions.
      await c.query(
        `SELECT pg_stat_statements_reset(0, s.dbid, 0)
           FROM (SELECT DISTINCT dbid FROM pg_stat_statements) s
          WHERE s.dbid <> 0 -- a zero dbid would make this a full reset, wiping other tests' entries
            AND s.dbid NOT IN (SELECT oid FROM pg_database WHERE datname LIKE 'qg\\_%')`
      );
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
      await c.query(`CREATE INDEX customers_lower_email_idx ON customers (lower(email))`);
      await c.query(`CREATE INDEX orders_closed_idx ON orders (customer_id) WHERE status = 'closed'`);
      await c.query(`CREATE INDEX orders_status_incl_idx ON orders (status) INCLUDE (total)`);
      await c.query(`
        CREATE TABLE events (id bigint NOT NULL, created_on date NOT NULL, kind text NOT NULL)
        PARTITION BY RANGE (created_on)`);
      await c.query(`CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')`);
      await c.query(`CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`);
      await c.query(`CREATE INDEX events_kind_idx ON events (kind)`);
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
      await c.query(
        `INSERT INTO events SELECT i, DATE '2025-06-01' + (i % 400), CASE WHEN i % 5 = 0 THEN 'signup' ELSE 'view' END
         FROM generate_series(1, 4000) AS i`
      );
      await c.query(
        `CREATE MATERIALIZED VIEW order_totals AS SELECT customer_id, sum(total) AS total FROM orders GROUP BY customer_id`
      );
      await c.query(`CREATE VIEW active_customers AS SELECT id, email FROM customers WHERE status = 'active'`);
      // VACUUM as well, so autovacuum has no reason to change the tables while a test compares refreshes.
      for (const t of ['customers', 'orders', 'events_2025', 'events_2026', 'order_totals']) await c.query(`VACUUM (ANALYZE) ${t}`);
      await c.query(`ANALYZE events`);

      // Simple-protocol texts: the server sees the literals and comments exactly as written.
      const workload = [
        `SELECT id FROM customers WHERE email = '${canaries.query_literal}'`,
        `UPDATE orders SET status = status WHERE note = '${canaries.query_literal_write}'`,
        `SELECT count(*) FROM orders /* ${canaries.query_comment_inline} */ WHERE status = 'shipped'`,
        `SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.id = 42 -- ${canaries.query_comment_trailing}`,
        // A positional GROUP BY is not a constant, so this literal survives normalization.
        `SELECT status, count(*) FROM orders GROUP BY 1`,
        // Views are not snapshot relations, so this reference stays unresolved.
        `SELECT count(*) FROM active_customers`,
      ];
      for (let i = 0; i < 5; i++) for (const q of workload) await c.query(q);
    } finally {
      await c.end();
    }
    await waitForTableStats(connect);
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
    config,
    createRole,
    cleanup,
  };
}

/**
 * Cumulative stats reach other sessions asynchronously (on 14, through the stats collector); wait
 * until the fixture's inserts and its VACUUM ANALYZE are both visible.
 */
async function waitForTableStats(connect: () => Promise<Client>): Promise<void> {
  const c = await connect();
  try {
    for (let i = 0; i < 100; i++) {
      const { rows } = await c.query(
        `SELECT coalesce(sum(n_tup_ins) FILTER (WHERE relname = 'customers'), 0)::int AS customers,
                coalesce(sum(n_tup_ins) FILTER (WHERE relname = 'orders'), 0)::int AS orders,
                count(*) FILTER (WHERE relname IN ('customers', 'orders') AND last_analyze IS NOT NULL)::int AS analyzed
           FROM pg_stat_user_tables`
      );
      if (rows[0].customers >= 5000 && rows[0].orders >= 20000 && rows[0].analyzed === 2) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('fixture inserts and ANALYZE never appeared in pg_stat_user_tables');
  } finally {
    await c.end();
  }
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

/**
 * Runs `queryguard snapshot <args>` from source with `env` and nothing else inherited, except
 * what the pg_dump shim needs (HOME and DOCKER_* for the docker CLI). The test pg_dump comes
 * first on PATH; `env.PATH` replaces PATH entirely.
 */
export function runSnapshotCli(args: readonly string[], env: Record<string, string>, cwd: string): SnapshotRun {
  const passThrough = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k === 'HOME' || k.startsWith('DOCKER_')) as [string, string][]
  );
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/index.ts'), 'snapshot', ...args],
    { cwd, env: { ...passThrough, PATH: `${pgDumpDir()}${path.delimiter}${process.env.PATH}`, ...env }, encoding: 'utf8' }
  );
  return { exitCode: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * The test pg_dump (Decision 7 in docs/design/snapshot.md): the real pg_dump 18 inside the PG18
 * test container, reached through docker compose. Each matrix server's host port (54NN) is mapped
 * to its compose service (pgNN), which is how the PG18 container reaches it.
 */
const PG_DUMP_SHIM = `#!/bin/sh
case "$PGPORT" in
  541[4-8]) host="pg\${PGPORT#54}" ;;
  *) host="$PGHOST" ;;
esac
exec docker compose -f "${path.join(ROOT, 'docker-compose.test.yml')}" exec -T \
  -e PGHOST="$host" -e PGPORT=5432 -e PGUSER="$PGUSER" -e PGPASSWORD="$PGPASSWORD" \
  -e PGDATABASE="$PGDATABASE" -e PGOPTIONS="$PGOPTIONS" -e PGAPPNAME="$PGAPPNAME" \
  pg18 pg_dump "$@"
`;

let shimDir: string | undefined;

/** A directory whose `pg_dump` is QG_TEST_PG_DUMP if set, otherwise the container shim. */
export function pgDumpDir(): string {
  if (shimDir) return shimDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-pgdump-'));
  const target = path.join(dir, 'pg_dump');
  if (process.env.QG_TEST_PG_DUMP) fs.symlinkSync(path.resolve(process.env.QG_TEST_PG_DUMP), target);
  else fs.writeFileSync(target, PG_DUMP_SHIM, { mode: 0o755 });
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return (shimDir = dir);
}

/** Fails loudly (never skips) without a pg_dump new enough for every server in the matrix. */
export function assertPgDump(): void {
  const v = pgDumpVersion(path.join(pgDumpDir(), 'pg_dump'));
  const newest = Math.max(...SNAPSHOT_VERSIONS);
  if (!v || v.major < newest) {
    throw new Error(
      `The snapshot tests need pg_dump ${newest} or newer, got ${v ? v.version : 'none'}. ` +
        'Run `npm run test:db:up` (the tests use pg_dump from the PG18 container), or set QG_TEST_PG_DUMP=/path/to/pg_dump.'
    );
  }
}

/** Runs the test pg_dump directly, e.g. to make a --schema-from file. */
export function runTestPgDump(args: readonly string[], env: Record<string, string>): string {
  const res = spawnSync(path.join(pgDumpDir(), 'pg_dump'), args, { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (res.status !== 0) throw new Error(`pg_dump failed: ${res.stderr}`);
  return res.stdout;
}

/** A database on a matrix server with no extension and no tables, as an owner superuser. */
export async function createBareDatabase(version: number): Promise<{
  config: ClientConfig;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}> {
  const server = snapshotServer(version);
  const database = `qg_bare_${hex(6)}`;
  const admin = new Client({ ...server, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  return {
    config: { ...server, database },
    env: { PGHOST: server.host, PGPORT: String(server.port), PGUSER: server.user, PGPASSWORD: server.password, PGDATABASE: database },
    async cleanup() {
      const a = new Client({ ...server, database: 'postgres' });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}

/** Runs a SQL script with psql inside a matrix server's container, stopping at the first error. */
export function psqlInContainer(version: number, database: string, sql: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(
    'docker',
    ['compose', '-f', path.join(ROOT, 'docker-compose.test.yml'), 'exec', '-T', `pg${version}`, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', PG.user, '-d', database],
    { input: sql, encoding: 'utf8', maxBuffer: 1 << 28 }
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}
