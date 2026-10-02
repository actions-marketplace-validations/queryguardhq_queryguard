// Phase 0 / item 3: every fix QueryGuard emits must (a) pass our own lint and
// (b) execute successfully against a real Postgres 16.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { Client } from 'pg';
import { analyzeDDLLocks } from '../src/locks';
import { splitSqlStatements } from '../src/splitter';
import { assertPostgres16, createSandbox, runCli, PG, Sandbox } from './harness';

const BASE_SCHEMA = `
  CREATE SCHEMA app;
  CREATE TABLE app."Mixed Case" ("Col" int);
  CREATE TABLE t (id serial PRIMARY KEY, c int, d text, name text, ts timestamp);
`;

before(async () => {
  await assertPostgres16();
});

async function withDb(fn: (sb: Sandbox, db: Client) => Promise<void>, schema = BASE_SCHEMA) {
  const sb = await createSandbox();
  const db = new Client({ ...PG, database: sb.database });
  await db.connect();
  try {
    await db.query(schema);
    await fn(sb, db);
  } finally {
    await db.end();
    await sb.cleanup();
  }
}

/** Lint-clean and executable, statement by statement (CONCURRENTLY can't share a transaction). */
async function assertFixesRoundTrip(db: Client, sqlStatements: string[]) {
  for (const fix of sqlStatements) {
    for (const stmt of splitSqlStatements(fix)) {
      assert.deepEqual(
        analyzeDDLLocks([stmt]).map((f) => f.lockType),
        [],
        `fix fails our own lint: ${stmt}`
      );
      await db.query(stmt);
    }
  }
}

interface Case {
  name: string;
  migration: string;
  findings: number;
  verify?: (db: Client) => Promise<void>;
}

const colType = async (db: Client, table: string, col: string) =>
  (
    await db.query(
      `SELECT format_type(atttypid, atttypmod) AS ty FROM pg_attribute
        WHERE attrelid = $1::regclass AND attname = $2`,
      [table, col]
    )
  ).rows[0]?.ty;

const CASES: Case[] = [
  { name: 'plain CREATE INDEX', migration: 'CREATE INDEX idx_a ON t(c)', findings: 1 },
  {
    name: 'UNIQUE, IF NOT EXISTS, USING, INCLUDE, partial',
    migration: `CREATE UNIQUE INDEX IF NOT EXISTS idx_b ON t USING btree (c) INCLUDE (id) WHERE c > 0`,
    findings: 1,
  },
  {
    name: 'quoted, schema-qualified names',
    migration: `CREATE INDEX "Idx A" ON app."Mixed Case" ("Col")`,
    findings: 1,
  },
  { name: 'unnamed index', migration: 'CREATE INDEX ON t (c)', findings: 1 },
  { name: 'expression index', migration: 'CREATE INDEX idx_e ON t (lower(name))', findings: 1 },
  {
    name: "the word CONCURRENTLY inside a string literal is not the keyword",
    migration: `CREATE INDEX idx_s ON t (c)\n  WHERE name = 'CONCURRENTLY'`,
    findings: 1,
  },
  {
    name: 'ALTER COLUMN TYPE',
    migration: 'ALTER TABLE t ALTER COLUMN c TYPE bigint',
    findings: 1,
    verify: async (db) => assert.equal(await colType(db, 't', 'c'), 'bigint'),
  },
  {
    name: 'SET DATA TYPE ... USING',
    migration: 'ALTER TABLE t ALTER COLUMN d SET DATA TYPE integer USING d::integer',
    findings: 1,
    verify: async (db) => assert.equal(await colType(db, 't', 'd'), 'integer'),
  },
  {
    name: 'quoted, schema-qualified ALTER with numeric(12,2)',
    migration: 'ALTER TABLE app."Mixed Case" ALTER COLUMN "Col" TYPE numeric(12,2)',
    findings: 1,
    verify: async (db) => assert.equal(await colType(db, 'app."Mixed Case"', 'Col'), 'numeric(12,2)'),
  },
  {
    name: 'multi-word type',
    migration: 'ALTER TABLE t ALTER COLUMN ts TYPE timestamp with time zone',
    findings: 1,
    verify: async (db) => assert.equal(await colType(db, 't', 'ts'), 'timestamp with time zone'),
  },
  {
    name: 'multi-action ALTER TABLE yields one finding per type change',
    migration:
      'ALTER TABLE t ADD COLUMN z int, ALTER COLUMN c TYPE bigint, ALTER COLUMN d TYPE numeric(10,2) USING d::numeric',
    findings: 2,
    verify: async (db) => {
      assert.equal(await colType(db, 't', 'c'), 'bigint');
      assert.equal(await colType(db, 't', 'd'), 'numeric(10,2)');
    },
  },
];

describe('lock-finding fixes round-trip against Postgres 16', () => {
  for (const c of CASES) {
    test(c.name, () =>
      withDb(async (_sb, db) => {
        const findings = analyzeDDLLocks(splitSqlStatements(c.migration));
        assert.equal(findings.length, c.findings);
        for (const f of findings) {
          assert.ok(f.remediation && f.remediation.sql.length > 0, 'finding must carry an executable fix');
        }
        await assertFixesRoundTrip(db, findings.flatMap((f) => f.remediation!.sql));
        await c.verify?.(db);
      })
    );
  }

  test('CREATE INDEX fix is the original statement with CONCURRENTLY spliced in (no template glitches)', () => {
    const [f] = analyzeDDLLocks(['CREATE INDEX idx_audit_logs_action ON audit_logs(action)']);
    assert.deepEqual(f.remediation!.sql, ['CREATE INDEX CONCURRENTLY idx_audit_logs_action ON audit_logs(action);']);
    assert.equal(f.targetTable, 'audit_logs');
  });

  test('ON ONLY (partitioned parent) gets guidance but no SQL that Postgres would reject', () => {
    const [f] = analyzeDDLLocks(['CREATE INDEX idx_p ON ONLY parent (c)']);
    assert.equal(f.remediation!.sql.length, 0);
    assert.match(f.remediation!.notes.join(' '), /partition/i);
  });

  test('all emitted fixes are accepted by the CLI linter (exit 0)', () => {
    const fixes = CASES.flatMap((c) => analyzeDDLLocks(splitSqlStatements(c.migration)).flatMap((f) => f.remediation!.sql));
    return withDb(async (sb) => {
      const file = sb.write('fixes.sql', fixes.join('\n'));
      const res = spawnSync(
        process.execPath,
        [path.resolve(__dirname, '../node_modules/tsx/dist/cli.mjs'), path.resolve(__dirname, '../src/index.ts'), '--lint', '--migration', file],
        { encoding: 'utf8' }
      );
      assert.equal(res.status, 0, res.stdout + res.stderr);
    });
  });
});

describe('seq-scan fixes round-trip (end to end through the CLI)', () => {
  const schema = `
    CREATE TABLE "Order Items" ("user" int, "Note" text);
    CREATE TABLE events (kind text);
  `;
  const queries = `
    SELECT * FROM "Order Items" WHERE "user" = 5;
    SELECT * FROM events WHERE kind = 'sample_7active';
    SELECT * FROM events WHERE kind IS NULL;
  `;

  test('every suggested index executes; undeterminable columns get no broken SQL', async () => {
    const sb = await createSandbox();
    const db = new Client({ ...PG, database: sb.database });
    try {
      const r = runCli(sb, { schema: sb.write('s.sql', schema), queries: sb.write('q.sql', queries) });
      assert.doesNotMatch(r.report, /\bON(?=[a-z_"])/, 'missing space after ON');
      assert.doesNotMatch(r.report, /\/\* columns \*\//, 'placeholder SQL must never be emitted');
      assert.match(r.report, /could not be determined/);

      const blocks = [...r.report.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((m) => m[1]);
      const fixes = blocks.filter((b) => /CREATE INDEX CONCURRENTLY/.test(b));
      assert.equal(fixes.length, 2, r.report);
      assert.ok(fixes.some((f) => f.includes('ON "Order Items" ("user")')), fixes.join('\n'));

      // The CLI already built the schema in this database; run the fixes against it.
      await db.connect();
      await assertFixesRoundTrip(db, fixes);
    } finally {
      await db.end().catch(() => {});
      await sb.cleanup();
    }
  });
});
