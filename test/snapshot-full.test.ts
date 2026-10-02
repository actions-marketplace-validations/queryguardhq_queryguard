// Phase 1 / item 5: full-stats mode (--mode full, PostgreSQL 18 servers).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import {
  Fixture,
  SNAPSHOT_VERSIONS,
  assertPgDump,
  assertSnapshotServer,
  createBareDatabase,
  createFixture,
  psqlInContainer,
  runSnapshotCli,
  runTestPgDump,
  scanForNeedles,
  shapeFunctionSql,
  snapshotServer,
} from './snapshot-harness';
import { buildStatsSql, parseAllowList, resolveAllowList } from '../src/snapshot/fullstats';
import { loadSnapshot } from '../src/snapshot/load';
import { Shape } from '../src/snapshot/types';

describe('allow-list', () => {
  test('one column per line; comments, blank lines and quoted identifiers', () => {
    const parsed = parseAllowList('# reviewed by security, 2026-10-02\n\npublic.customers.status\norders.Status  # folds\n"Billing"."Invoices"."Due Date"\n');
    assert.deepEqual(parsed.map((p) => p.parts), [
      ['public', 'customers', 'status'],
      ['orders', 'status'],
      ['Billing', 'Invoices', 'Due Date'],
    ]);
  });

  test('anything else is an error with its line number', () => {
    assert.throws(() => parseAllowList('public.customers.status\ncustomers\na.b.c.d\npublic.customers.*\n'), /line 2: .*line 3: .*line 4: /);
  });

  const shape = {
    relations: [
      { schema: 'public', name: 'orders', columns: [{ name: 'status' }] },
      { schema: 'public', name: 'events', columns: [{ name: 'kind' }] },
      { schema: 'archive', name: 'events', columns: [{ name: 'kind' }] },
    ],
  } as unknown as Shape;

  test('entries resolve against the snapshot; unknown or ambiguous ones fail the run', () => {
    assert.deepEqual(resolveAllowList(parseAllowList('orders.status\npublic.orders.status\narchive.events.kind'), shape), [
      { schema: 'public', table: 'orders', column: 'status' },
      { schema: 'archive', table: 'events', column: 'kind' },
    ]);
    assert.throws(() => resolveAllowList(parseAllowList('events.kind'), shape), /line 1: table name is ambiguous/);
    assert.throws(() => resolveAllowList(parseAllowList('orders.nope\nnope.status'), shape), /line 1: no column nope.*line 2: no such table/);
  });
});

describe('stats.sql generation', () => {
  const shape: Shape = {
    block_size: 8192, size_source: 'relpages', column_stats_source: 'pg_stats', stats_reset: { database: null }, indexes: [],
    relations: [
      {
        schema: 'public', name: "o'brien", kind: 'table', partition_of: null, reltuples: 5000, relpages: 40, relallvisible: 40,
        size_bytes: { table: 1, indexes: 1, total: 2 }, activity: null, last_analyze: null,
        columns: [
          { name: 'a', attnum: 1, stats: [{ inherited: false, null_frac: 0, avg_width: 4, n_distinct: 3, correlation: 0.5, mcv_freqs: [0.5, 0.3, 0.2] }] },
          { name: 'b', attnum: 2, stats: [{ inherited: false, null_frac: 0.1, avg_width: 9, n_distinct: -1, correlation: null, mcv_freqs: null }] },
        ],
      },
    ],
  };
  const sql = buildStatsSql(shape, new Map([[JSON.stringify(['public', "o'brien"]), 7]]), [
    { schema: 'public', table: "o'brien", column: 'a', inherited: false, fields: { most_common_vals: '{x,"$qg$",it\'s}', most_common_freqs: '{0.5,0.3,0.2}', histogram_bounds: null, most_common_elems: null, most_common_elem_freqs: null, elem_count_histogram: null, range_length_histogram: null, range_empty_frac: null, range_bounds_histogram: null } },
  ], 180006);

  test('an allow-listed column carries its values; others carry shape fields only', () => {
    const [, relation, a, b] = sql.split(/^DO /m);
    assert.match(relation, /'relname', 'o''brien'/);
    assert.match(relation, /'relallfrozen', '7'::integer/);
    assert.match(a, /'most_common_vals', '\{x,"\$qg\$",it''s\}'::text/);
    assert.match(a, /'most_common_freqs', '\{0\.5,0\.3,0\.2\}'::real\[\]/);
    assert.doesNotMatch(b, /most_common|histogram/, 'no frequencies without values');
    assert.match(b, /'null_frac', '0\.1'::real/);
  });

  test('every call raises if it returns false, and the dollar quote never collides with a value', () => {
    assert.equal(sql.match(/^DO \$/gm)!.length, 3);
    assert.equal(sql.match(/THEN\n  RAISE EXCEPTION/g)!.length, 3);
    assert.match(sql, /DO \$qg1\$BEGIN[\s\S]*\$qg\$[\s\S]*END\$qg1\$;/, 'a value containing $qg$ gets another tag');
  });
});

const fullVersion = SNAPSHOT_VERSIONS.find((v) => v >= 18);
const olderVersion = SNAPSHOT_VERSIONS.find((v) => v < 18);

if (olderVersion !== undefined) {
  describe(`Postgres ${olderVersion}: full mode`, () => {
    test('needs a PostgreSQL 18 server', async () => {
      await assertSnapshotServer(olderVersion);
      const bare = await createBareDatabase(olderVersion);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-full-old-'));
      try {
        fs.writeFileSync(path.join(tmp, 'allow.txt'), 'public.t.c\n');
        const r = runSnapshotCli(['--label', 'x', '--mode', 'full', '--allow-columns', 'allow.txt'], bare.env, tmp);
        assert.equal(r.exitCode, 1);
        assert.match(r.stderr, /--mode full needs a PostgreSQL 18 or newer server/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        await bare.cleanup();
      }
    });
  });
}

if (fullVersion !== undefined) {
  describe(`Postgres ${fullVersion}: full mode`, () => {
    let fx: Fixture;
    let tmp: string;
    let out: string;
    const ALLOW = '# Columns whose values may leave production. Reviewed by security.\npublic.customers.status\norders.status\n';

    before(async () => {
      await assertSnapshotServer(fullVersion);
      assertPgDump();
      fx = await createFixture(fullVersion);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-full-'));
      fs.writeFileSync(path.join(tmp, 'allow.txt'), ALLOW);
      out = path.join(tmp, 'full');
      const r = runSnapshotCli(['--label', 'full', '--out', out, '--mode', 'full', '--allow-columns', 'allow.txt'], fx.env, tmp);
      assert.equal(r.exitCode, 0, `${r.stdout}\n${r.stderr}`);
    });

    after(async () => {
      await fx?.cleanup();
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('the manifest names the allow-listed columns, and stats.sql is part of the verified artifact', () => {
      const loaded = loadSnapshot(out);
      assert.ok(loaded.ok, loaded.ok ? '' : loaded.errors.join('\n'));
      assert.equal(loaded.snapshot.manifest.mode, 'full');
      assert.deepEqual(loaded.snapshot.manifest.allowed_columns, ['public.customers.status', 'public.orders.status']);
      assert.ok(loaded.snapshot.statsSql?.includes('pg_catalog.pg_restore_attribute_stats('));
    });

    test('only allow-listed values leave: the status canary is in stats.sql, no other canary is anywhere', () => {
      const stats = fs.readFileSync(path.join(out, 'stats.sql'), 'utf8');
      assert.ok(stats.includes(fx.canaries.status), 'the allow-listed column really carries its values');
      const { status, ...others } = fx.canaries;
      void status;
      const leaks = scanForNeedles(out, { ...others, role: fx.role, password: fx.password, database: fx.database });
      assert.deepEqual(leaks.map((l) => `${l.label} in ${l.file}`), []);
      assert.equal(stats.match(/'most_common_vals'/g)?.length, 2, 'exactly the two allow-listed columns');
    });

    test('stats.sql applies cleanly to a fresh PostgreSQL 18 database built from schema.sql', async () => {
      const target = `qg_target_${Date.now()}`;
      const admin = new Client({ ...snapshotServer(fullVersion), database: 'postgres' });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${target}`);
      try {
        const schema = psqlInContainer(fullVersion, target, fs.readFileSync(path.join(out, 'schema.sql'), 'utf8'));
        assert.equal(schema.status, 0, schema.stderr);
        const stats = psqlInContainer(fullVersion, target, fs.readFileSync(path.join(out, 'stats.sql'), 'utf8'));
        assert.equal(stats.status, 0, stats.stderr);
        assert.doesNotMatch(stats.stderr, /WARNING|ERROR/, stats.stderr);

        const q = `SELECT tablename, attname, inherited, null_frac, n_distinct, most_common_vals::text AS mcv,
                          most_common_freqs::text AS freqs, histogram_bounds::text AS hist
                     FROM pg_stats WHERE schemaname = 'public' ORDER BY 1, 2, 3`;
        const src = await fx.connect();
        const dst = new Client({ ...snapshotServer(fullVersion), database: target });
        await dst.connect();
        try {
          const [s, d] = [(await src.query(q)).rows, (await dst.query(q)).rows];
          const find = (rows: any[], t: string, a: string) => rows.find((r) => r.tablename === t && r.attname === a && !r.inherited);
          for (const [t, a] of [['customers', 'status'], ['orders', 'status']]) {
            assert.equal(find(d, t, a).mcv, find(s, t, a).mcv, `${t}.${a} values`);
            assert.equal(find(d, t, a).freqs, find(s, t, a).freqs, `${t}.${a} frequencies`);
          }
          const email = find(d, 'customers', 'email');
          assert.equal(email.n_distinct, -1);
          assert.equal(email.mcv, null);
          assert.equal(email.hist, null, 'not allow-listed: no histogram');
          assert.ok(find(s, 'customers', 'email').hist, 'control: the source does have one');
          assert.ok(d.some((r) => r.tablename === 'events' && r.inherited), 'partitioned parent stats');
          const reltuples = await dst.query(`SELECT reltuples FROM pg_class WHERE oid = 'public.customers'::regclass`);
          assert.equal(Number(reltuples.rows[0].reltuples), 5000);
        } finally {
          await src.end();
          await dst.end();
        }
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
        await admin.end();
      }
    });

    test('least privilege: shape function, --schema-from, and column grants for exactly the allow-list', async () => {
      const login = await fx.createRole();
      const c = await fx.connect();
      try {
        await c.query(`GRANT pg_read_all_stats TO ${login.role}`);
        for (const sql of shapeFunctionSql(login.role)) await c.query(sql);
        const schemaFile = path.join(tmp, 'schema-from-owner.sql');
        fs.writeFileSync(schemaFile, runTestPgDump(['--schema-only'], fx.env));
        const env = { ...fx.env, PGUSER: login.role, PGPASSWORD: login.password };
        const args = (dir: string) => ['--label', 'lp', '--out', path.join(tmp, dir), '--mode', 'full', '--allow-columns', 'allow.txt', '--schema-from', schemaFile];

        const hidden = runSnapshotCli(args('hidden'), env, tmp);
        assert.equal(hidden.exitCode, 2, hidden.stderr);
        const m = JSON.parse(fs.readFileSync(path.join(tmp, 'hidden', 'manifest.json'), 'utf8'));
        assert.deepEqual(
          m.partial_reasons.map((p: any) => p.scope).sort(),
          ['stats:public.customers.status', 'stats:public.orders.status']
        );
        assert.ok(!fs.readFileSync(path.join(tmp, 'hidden', 'stats.sql'), 'utf8').includes(fx.canaries.status));

        await c.query(`GRANT SELECT (status) ON customers, orders TO ${login.role}`);
        const granted = runSnapshotCli(args('granted'), env, tmp);
        assert.equal(granted.exitCode, 0, `${granted.stdout}\n${granted.stderr}`);
        assert.ok(fs.readFileSync(path.join(tmp, 'granted', 'stats.sql'), 'utf8').includes(fx.canaries.status));
        const asRole = new Client(fx.config(login));
        await asRole.connect();
        try {
          await assert.rejects(asRole.query('SELECT email FROM customers LIMIT 1'), { code: '42501' });
        } finally {
          await asRole.end();
        }
      } finally {
        await c.query(`DROP SCHEMA IF EXISTS queryguard CASCADE`);
        await c.end();
      }
    });

    test('an allow-list entry that matches nothing fails the run and writes nothing', () => {
      fs.writeFileSync(path.join(tmp, 'typo.txt'), 'public.customers.statuss\n');
      const r = runSnapshotCli(['--label', 'x', '--out', path.join(tmp, 'typo'), '--mode', 'full', '--allow-columns', 'typo.txt'], fx.env, tmp);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /line 1: no column statuss in public\.customers/);
      assert.ok(!fs.existsSync(path.join(tmp, 'typo')));
    });
  });
}
