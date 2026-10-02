// Phase 1 / item 2: shape collection (default "shape" mode).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClientConfig } from 'pg';
import { Fixture, SNAPSHOT_VERSIONS, assertSnapshotServer, createFixture, shapeFunctionSql } from './snapshot-harness';
import { openSnapshotSession, Queryable, readOnly } from '../src/snapshot/session';
import { collectShape, ShapeResult } from '../src/snapshot/shape';
import { RelationShape } from '../src/snapshot/types';

/** pg_stats fields that carry values. Shape mode must never export, or even select, any of them. */
const VALUE_FIELDS = [
  'most_common_vals',
  'histogram_bounds',
  'most_common_elems',
  'most_common_elem_freqs',
  'elem_count_histogram',
  'range_length_histogram',
  'range_empty_frac',
  'range_bounds_histogram',
];

interface Collected extends ShapeResult {
  statements: string[];
}

/** Collects as a snapshot session would, recording every statement sent. `intercept` may fail a statement. */
async function collect(config: ClientConfig, intercept?: (text: string, values?: unknown[]) => void): Promise<Collected> {
  const client = await openSnapshotSession(config);
  const statements: string[] = [];
  const db: Queryable = {
    query: (text, values) => {
      statements.push(text);
      intercept?.(text, values);
      return client.query(text, values as any[]);
    },
  };
  try {
    const version = Number((await client.query(`SHOW server_version_num`)).rows[0].server_version_num);
    const result = await readOnly(db, () => collectShape(db, version));
    return { ...result, statements };
  } finally {
    await client.end();
  }
}

const rel = (r: ShapeResult, name: string): RelationShape => {
  const found = r.shape.relations.find((x) => x.schema === 'public' && x.name === name);
  assert.ok(found, `relation ${name} missing`);
  return found!;
};

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

for (const version of SNAPSHOT_VERSIONS) {
  describe(`Postgres ${version}: shape collection`, () => {
    let fx: Fixture;
    let owner: Collected;

    before(async () => {
      await assertSnapshotServer(version);
      fx = await createFixture(version);
      owner = await collect(fx.config());
    });

    after(async () => {
      await fx?.cleanup();
    });

    test('relations: kind, partitions, estimates and relpages-based sizes', () => {
      const customers = rel(owner, 'customers');
      assert.equal(customers.kind, 'table');
      assert.equal(customers.partition_of, null);
      assert.equal(customers.reltuples, 5000);
      assert.ok(customers.relpages > 0);
      const s = customers.size_bytes!;
      assert.ok(s.table >= customers.relpages * owner.shape.block_size, 'heap size covers relpages');
      const indexSum = owner.shape.indexes
        .filter((i) => i.table_name === 'customers')
        .reduce((n, i) => n + i.size_bytes, 0);
      assert.equal(s.indexes, indexSum);
      assert.equal(s.total, s.table + s.indexes);

      assert.equal(rel(owner, 'events').kind, 'partitioned_table');
      assert.equal(rel(owner, 'events_2025').partition_of, 'public.events');
      assert.equal(rel(owner, 'order_totals').kind, 'matview');
      assert.equal(owner.shape.size_source, 'relpages');
      assert.ok(
        owner.shape.relations.every((r) => r.schema !== 'pg_catalog' && r.schema !== 'information_schema'),
        'system relations are excluded'
      );
    });

    test('activity counters and the stats_reset time they count from', () => {
      const a = rel(owner, 'customers').activity!;
      assert.equal(a.n_tup_ins, 5000);
      // An estimate: on 14-16, ANALYZE's count plus the inserts still pending from the same session.
      assert.ok(a.n_live_tup >= 5000);
      for (const k of ['n_dead_tup', 'seq_scan', 'idx_scan', 'n_tup_upd', 'n_tup_del'] as const) {
        assert.equal(typeof a[k], 'number', k);
      }
      assert.ok(rel(owner, 'customers').last_analyze);
      assert.ok('database' in owner.shape.stats_reset);
      const reset = owner.shape.stats_reset.database;
      assert.ok(reset === null || !Number.isNaN(Date.parse(reset)));
    });

    test('indexes: columns, expressions, INCLUDE, uniqueness, validity, partial flag, scans', () => {
      const idx = (name: string) => {
        const found = owner.shape.indexes.find((i) => i.name === name);
        assert.ok(found, `index ${name} missing`);
        return found!;
      };
      assert.deepEqual(idx('customers_email_key').keys, [{ column: 'email' }]);
      assert.equal(idx('customers_email_key').unique, true);
      assert.equal(idx('customers_email_key').valid, true);
      assert.equal(idx('customers_pkey').primary, true);
      assert.deepEqual(idx('customers_lower_email_idx').keys, [{ expression: null }], 'text comes from schema.sql');
      assert.deepEqual(idx('orders_status_incl_idx').keys, [{ column: 'status' }]);
      assert.deepEqual(idx('orders_status_incl_idx').include, ['total']);
      assert.equal(idx('orders_closed_idx').partial, true);
      assert.equal(idx('orders_customer_id_idx').table_name, 'orders');
      assert.equal(idx('events_kind_idx').kind, 'partitioned_index');
      assert.ok(idx('customers_email_key').size_bytes > 0);
      assert.equal(typeof idx('customers_email_key').idx_scan, 'number');
    });

    test('columns: skew profile only, with inherited rows on a partitioned table', () => {
      const status = rel(owner, 'customers').columns.find((c) => c.name === 'status')!;
      assert.equal(status.missing, undefined);
      assert.equal(status.stats.length, 1);
      const st = status.stats[0];
      assert.equal(st.inherited, false);
      assert.equal(st.null_frac, 0);
      assert.equal(st.n_distinct, 3);
      assert.equal(st.mcv_freqs!.length, 3);
      assert.ok(Math.abs(st.mcv_freqs!.reduce((a, b) => a + b, 0) - 1) < 0.01);
      assert.equal(typeof st.correlation, 'number');

      const email = rel(owner, 'customers').columns.find((c) => c.name === 'email')!;
      assert.equal(email.stats[0].n_distinct, -1, 'unique column');

      const parentKind = rel(owner, 'events').columns.find((c) => c.name === 'kind')!;
      assert.deepEqual(parentKind.stats.map((s) => s.inherited), [true]);
      const childKind = rel(owner, 'events_2025').columns.find((c) => c.name === 'kind')!;
      assert.deepEqual(childKind.stats.map((s) => s.inherited), [false]);

      assert.deepEqual(owner.partial, [], 'everything is readable to the owner');
    });

    test('no value-bearing statistic is exported, or even selected', () => {
      const keys = keysOf(owner.shape);
      for (const f of VALUE_FIELDS) assert.ok(!keys.has(f), `exported ${f}`);
      for (const s of owner.statements) {
        for (const f of VALUE_FIELDS) assert.ok(!s.includes(f), `selected ${f} in: ${s}`);
      }
      const json = JSON.stringify(owner.shape);
      for (const [cls, canary] of Object.entries(fx.canaries)) assert.ok(!json.includes(canary), `canary ${cls}`);
      assert.ok(!json.includes("'closed'"), 'the partial-index predicate is not exported');
    });

    test('reads only catalogs and statistics views, schema-qualified', () => {
      const control = [
        /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/,
        /^COMMIT$/,
        /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) qg_\w+$/,
        /^SET LOCAL stats_fetch_consistency = 'snapshot'$/,
      ];
      for (const raw of owner.statements) {
        const s = raw.trim();
        if (control.some((re) => re.test(s))) continue;
        assert.match(s, /^SELECT\b/, s);
        assert.doesNotMatch(
          s,
          // The size and deparse functions wait on table locks (design doc, V4).
          /\b(ANALYZE|VACUUM|LOCK|INSERT|UPDATE|DELETE|pg_relation_size|pg_total_relation_size|pg_table_size|pg_indexes_size|pg_get_indexdef|pg_get_expr|pg_get_viewdef|pg_stat_reset\w*)\b/i,
          s
        );
        for (const m of s.matchAll(/\b(?:FROM|JOIN)\s+([^\s(]+)/gi)) {
          assert.match(m[1], /^(pg_catalog\.[a-z_]+|queryguard\.column_shape)$/, `reads ${m[1]} in: ${s}`);
        }
      }
    });

    test('never waits on a user-table lock', async () => {
      const holder = await fx.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE customers, orders, events IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        const locked = await collect(fx.config());
        assert.deepEqual(locked.partial, []);
        assert.ok(locked.shape.relations.every((r) => !r.error));
        assert.equal(rel(locked, 'customers').reltuples, 5000);
        assert.ok(Date.now() - started < 5000, 'collection did not wait');

        // Control: the size functions *would* wait, and lock_timeout turns that into an error.
        const s = await openSnapshotSession(fx.config());
        try {
          await assert.rejects(s.query(`SELECT pg_catalog.pg_relation_size('public.customers')`), { code: '55P03' });
        } finally {
          await s.end();
        }
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    });

    test('a relation that fails is recorded with its reason, and the others are still collected', async () => {
      const c = await fx.connect();
      const oid = (await c.query(`SELECT 'public.customers'::regclass::oid::text AS oid`)).rows[0].oid;
      await c.end();
      const r = await collect(fx.config(), (text, values) => {
        const oids = (values?.[0] ?? []) as string[];
        if (text.includes('pg_catalog.pg_index x') && oids.includes(oid)) throw new Error('simulated lock timeout');
      });
      const customers = rel(r, 'customers');
      assert.match(customers.error ?? '', /simulated lock timeout/);
      assert.deepEqual(
        r.partial.filter((p) => p.scope === 'shape:public.customers').map((p) => p.reason),
        ['collection failed: simulated lock timeout']
      );
      assert.ok(!r.shape.indexes.some((i) => i.table_name === 'customers'));
      const orders = rel(r, 'orders');
      assert.equal(orders.error, undefined);
      assert.ok(orders.activity && orders.columns.length > 0);
      assert.ok(r.shape.indexes.some((i) => i.table_name === 'orders'));
    });

    describe('least-privileged roles', () => {
      test('pg_read_all_stats alone: relation shape, but column statistics hidden and PARTIAL', async () => {
        const login = await fx.createRole();
        const c = await fx.connect();
        await c.query(`GRANT pg_read_all_stats TO ${login.role}`);
        await c.end();

        const r = await collect(fx.config(login));
        assert.equal(r.shape.column_stats_source, 'pg_stats');
        const customers = rel(r, 'customers');
        assert.equal(customers.reltuples, 5000);
        assert.ok(customers.activity);
        assert.ok(customers.columns.length > 0);
        assert.ok(customers.columns.every((col) => col.missing === 'no_privilege' && col.stats.length === 0));
        assert.ok(
          r.partial.some((p) => p.scope === 'shape:public.customers' && /no SELECT privilege/.test(p.reason)),
          JSON.stringify(r.partial)
        );
      });

      test('a column-level grant exposes exactly that column', async () => {
        const login = await fx.createRole();
        const c = await fx.connect();
        await c.query(`GRANT SELECT (status) ON customers TO ${login.role}`);
        await c.end();

        const cols = rel(await collect(fx.config(login)), 'customers').columns;
        assert.equal(cols.find((col) => col.name === 'status')!.stats.length, 1);
        assert.equal(cols.find((col) => col.name === 'email')!.missing, 'no_privilege');
      });

      test('row-level security hides statistics; reported as hidden_by_rls', async () => {
        const login = await fx.createRole();
        const c = await fx.connect();
        try {
          await c.query(`CREATE TABLE notes (id int, body text)`);
          await c.query(`INSERT INTO notes SELECT i, 'n' || i FROM generate_series(1, 200) AS i`);
          await c.query(`ANALYZE notes`);
          await c.query(`ALTER TABLE notes ENABLE ROW LEVEL SECURITY`);
          await c.query(`GRANT SELECT ON notes TO ${login.role}`);

          const r = await collect(fx.config(login));
          assert.ok(rel(r, 'notes').columns.every((col) => col.missing === 'hidden_by_rls'));
          assert.ok(r.partial.some((p) => p.scope === 'shape:public.notes' && /row-level security/.test(p.reason)));
        } finally {
          await c.query(`DROP TABLE IF EXISTS notes`);
          await c.end();
        }
      });

      test('the shape function: full skew profile without SELECT on any table', async () => {
        const login = await fx.createRole();
        const c = await fx.connect();
        try {
          for (const sql of shapeFunctionSql(login.role)) await c.query(sql);
          const r = await collect(fx.config(login));
          assert.equal(r.shape.column_stats_source, 'queryguard.column_shape');
          const cols = rel(r, 'customers').columns;
          assert.ok(cols.every((col) => col.stats.length === 1 && col.missing === undefined));
          assert.deepEqual(r.partial, []);
          // The role really cannot read rows.
          const asRole = await openSnapshotSession(fx.config(login));
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
    });
  });
}
