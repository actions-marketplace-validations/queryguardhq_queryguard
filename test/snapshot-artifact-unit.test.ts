// Phase 1 / item 4: schema.sql processing, number formatting and schema validation, without a database.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareRelations, createIndexKeys, fillIndexExpressions, processDump } from '../src/snapshot/schema-sql';
import { formatShape, formatWorkload, frac, sig2 } from '../src/snapshot/format';
import { validateSnapshot } from '../src/snapshot/validate';
import { IndexShape, Shape, Workload } from '../src/snapshot/types';

const entry = (name: string, type: string, schema: string, owner: string, body: string, toc = false) =>
  ['--', ...(toc ? ['-- TOC entry 215 (class 1259 OID 16390)'] : []), `-- Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: ${owner}`, '--', '', body, ''].join('\n');

const DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '\\restrict AbCdEf123',
  '',
  '-- Dumped from database version 16.4 (Debian 16.4-1)',
  '-- Dumped by pg_dump version 18.6',
  '',
  "SET statement_timeout = 0;",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  '',
  entry('customers', 'TABLE', 'public', 'alice', 'CREATE TABLE public.customers (\n    id bigint NOT NULL,\n    email text\n);\n\n\nALTER TABLE public.customers OWNER TO alice;', true),
  entry('COLUMN customers.email', 'COMMENT', 'public', 'alice', "COMMENT ON COLUMN public.customers.email IS 'call Bob at 555-0100';"),
  entry('totals', 'MATERIALIZED VIEW', 'public', 'alice', 'CREATE MATERIALIZED VIEW public.totals AS\n SELECT 1 AS one\n  WITH NO DATA;'),
  entry('active', 'VIEW', 'public', 'alice', 'CREATE VIEW public.active AS\n SELECT 1 AS one;'),
  entry('remote', 'FOREIGN TABLE', 'billing', 'alice', 'CREATE FOREIGN TABLE billing.remote (\n    id integer\n)\nSERVER ledger;'),
  entry('ledger', 'SERVER', '-', 'alice', "CREATE SERVER ledger FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'ledger.internal', dbname 'prod');"),
  entry('USER MAPPING alice SERVER ledger', 'USER MAPPING', '-', 'alice', "CREATE USER MAPPING FOR alice SERVER ledger OPTIONS (user 'svc', password 'hunter2');"),
  entry('TABLE customers', 'ACL', 'public', 'alice', 'GRANT SELECT ON TABLE public.customers TO reporting;'),
  entry('customers_lower_idx', 'INDEX', 'public', 'alice', 'CREATE INDEX customers_lower_idx ON public.customers USING btree (lower(email) text_pattern_ops, id DESC);'),
  '--',
  '-- PostgreSQL database dump complete',
  '--',
  '',
  '\\unrestrict AbCdEf123',
  '',
].join('\n');

describe('schema.sql processing', () => {
  const d = processDump(DUMP);

  test('removes servers, user mappings, comments and ACLs, and counts them', () => {
    assert.deepEqual(d.redactions.removed_entries, { COMMENT: 1, SERVER: 1, 'USER MAPPING': 1, ACL: 1 });
    for (const secret of ['hunter2', 'ledger.internal', '555-0100', 'reporting', 'GRANT', 'COMMENT ON']) {
      assert.ok(!d.text.includes(secret), secret);
    }
  });

  test('removes owner names, \\restrict lines and version/OID noise', () => {
    // 5 kept objects named their owner in the header, plus one ALTER ... OWNER TO line.
    assert.deepEqual(d.redactions.removed_lines, { owner: 6, restrict: 2, connect: 0 });
    for (const noise of ['alice', '\\restrict', 'Dumped from', 'Dumped by', 'TOC entry']) assert.ok(!d.text.includes(noise), noise);
    assert.match(d.text, /-- Name: customers; Type: TABLE; Schema: public; Owner: -\n/);
    assert.match(d.text, /CREATE TABLE public\.customers \(/);
    assert.ok(!/\n{3,}/.test(d.text), 'no runs of blank lines');
  });

  test('reads versions, relations and index keys', () => {
    assert.equal(d.dumpedFromMajor, 16);
    assert.equal(d.dumpedByVersion, '18.6');
    assert.deepEqual([...d.relations].sort(), ['billing\u0000remote', 'public\u0000customers', 'public\u0000totals']);
    assert.deepEqual(d.indexKeys.get('public\u0000customers_lower_idx'), [{ expression: 'lower(email)' }, { column: 'id' }]);
  });

  test('rejects a dump with data, and anything that is not a pg_dump', () => {
    assert.throws(() => processDump(DUMP + entry('customers', 'TABLE DATA', 'public', 'alice', 'COPY public.customers (id) FROM stdin;\n1\n\\.')), /contains data \(TABLE DATA\)/);
    assert.throws(() => processDump(DUMP + entry('s', 'SEQUENCE SET', 'public', 'alice', "SELECT pg_catalog.setval('public.s', 42, true);")), /contains data/);
    assert.throws(() => processDump('CREATE TABLE t (id int);\n'), /not a plain-format pg_dump/);
  });

  test('DATABASE entries (pg_dump --create) and \\connect lines are removed', () => {
    // pg_dump --create puts \connect inside the DATABASE entry, which goes as a whole.
    const created = processDump(DUMP + entry('appdb', 'DATABASE', '-', 'alice', 'CREATE DATABASE appdb;\n\n\\connect appdb'));
    assert.equal(created.redactions.removed_entries.DATABASE, 1);
    assert.ok(!created.text.includes('appdb'));
    const stray = processDump(DUMP.replace('SET statement_timeout = 0;', '\\connect -reuse-previous=on "dbname=\'appdb\'"\nSET statement_timeout = 0;'));
    assert.equal(stray.redactions.removed_lines.connect, 1);
    assert.ok(!stray.text.includes('appdb'));
  });
});

describe('index keys from CREATE INDEX', () => {
  const cases: Array<[string, unknown]> = [
    ['CREATE INDEX i ON public.t USING btree (a)', [{ column: 'a' }]],
    ['CREATE UNIQUE INDEX i ON public.t USING btree (a, "Mixed Col")', [{ column: 'a' }, { column: 'Mixed Col' }]],
    ['CREATE INDEX i ON public.t USING btree (lower(email))', [{ expression: 'lower(email)' }]],
    ['CREATE INDEX i ON public.t USING btree (((a + b)) DESC NULLS LAST)', [{ expression: '(a + b)' }]],
    ['CREATE INDEX i ON public.t USING btree ((a + b))', [{ expression: 'a + b' }]],
    ["CREATE INDEX i ON public.t USING btree (COALESCE(status, 'none'::text) COLLATE \"C\")", [{ expression: "COALESCE(status, 'none'::text)" }]],
    ['CREATE INDEX i ON public.t USING gin (public.f(doc) jsonb_path_ops)', [{ expression: 'public.f(doc)' }]],
    ['CREATE INDEX i ON ONLY public.t USING btree (kind) INCLUDE (total) WHERE (x > 0)', [{ column: 'kind' }]],
  ];
  for (const [sql, want] of cases) test(sql, () => assert.deepEqual(createIndexKeys(sql), want));
  test('unrecognized forms give null rather than a guess', () => {
    assert.equal(createIndexKeys('CREATE INDEX i ON t (a)'), null);
  });
});

describe('reconciling schema.sql with the catalog', () => {
  const d = processDump(DUMP);
  test('relations only on one side are reported', () => {
    const reasons = compareRelations(d, {
      relations: [
        { schema: 'public', name: 'customers' },
        { schema: 'public', name: 'totals' },
        { schema: 'public', name: 'late_table' },
      ],
    });
    assert.deepEqual(
      reasons.map((r) => r.reason),
      [
        'schema.sql is missing 1 relation(s) the catalog has: public.late_table',
        'schema.sql has 1 relation(s) the catalog does not: billing.remote',
      ]
    );
  });

  const index = (name: string, keys: IndexShape['keys']): IndexShape => ({
    schema: 'public', name, table_schema: 'public', table_name: 'customers', kind: 'index', method: 'btree',
    unique: false, primary: false, valid: true, partial: false, keys, include: [], size_bytes: 0, idx_scan: 0,
  });

  test('expression text is filled in by position; a mismatch is reported, not guessed', () => {
    const ok = index('customers_lower_idx', [{ expression: null }, { column: 'id' }]);
    const wrongOrder = index('customers_lower_idx', [{ column: 'id' }, { expression: null }]);
    const unknown = index('nowhere_idx', [{ expression: null }]);
    const reasons = fillIndexExpressions(d, [ok, wrongOrder, unknown]);
    assert.deepEqual(ok.keys, [{ expression: 'lower(email)' }, { column: 'id' }]);
    assert.deepEqual(wrongOrder.keys, [{ column: 'id' }, { expression: null }]);
    assert.match(reasons[0].reason, /for 2 index\(es\): public\.customers_lower_idx, public\.nowhere_idx/);
  });
});

describe('number formatting', () => {
  test('sig2 and frac', () => {
    assert.deepEqual([48213551, 5000, 1234, 99, 0.012345, 0].map(sig2), [48000000, 5000, 1200, 99, 0.012, 0]);
    assert.deepEqual([0.123456, -0.00001, 1, -1].map(frac), [0.1235, 0, 1, -1]);
    assert.equal(Object.is(frac(-0.00001), -0), false);
  });

  const shape: Shape = {
    block_size: 8192,
    size_source: 'relpages',
    column_stats_source: 'pg_stats',
    stats_reset: { database: null },
    relations: [
      {
        schema: 'public', name: 't', kind: 'table', partition_of: null, reltuples: 48213551, relpages: 123457,
        relallvisible: 120001, size_bytes: { table: 1011359744, indexes: 3, total: 1011359747 },
        activity: { n_live_tup: 48213551, n_dead_tup: 1234, seq_scan: 17, idx_scan: null, n_tup_ins: 9876543, n_tup_upd: 0, n_tup_del: 5 },
        last_analyze: null,
        columns: [
          { name: 'c', attnum: 3, stats: [{ inherited: false, null_frac: 0.123456, avg_width: 123, n_distinct: -0.987654, correlation: 0.99999, mcv_freqs: [0.5, 0.33333] }] },
          { name: 'd', attnum: 4, stats: [{ inherited: false, null_frac: 0, avg_width: 4, n_distinct: 4567, correlation: null, mcv_freqs: null }] },
        ],
      },
    ],
    indexes: [],
  };

  test('approx rounds every measurement to 2 significant figures and fractions to 4 decimals', () => {
    const r = formatShape(shape, 'approx').relations[0];
    assert.deepEqual([r.reltuples, r.relpages, r.relallvisible], [48000000, 120000, 120000]);
    assert.deepEqual(r.size_bytes, { table: 1000000000, indexes: 3, total: 1000000000 });
    assert.deepEqual(r.activity, { n_live_tup: 48000000, n_dead_tup: 1200, seq_scan: 17, idx_scan: null, n_tup_ins: 9900000, n_tup_upd: 0, n_tup_del: 5 });
    assert.deepEqual(r.columns[0].stats[0], { inherited: false, null_frac: 0.1235, avg_width: 120, n_distinct: -0.9877, correlation: 1, mcv_freqs: [0.5, 0.3333] });
    assert.equal(r.columns[1].stats[0].n_distinct, 4600);
    assert.equal(r.columns[0].attnum, 3, 'identifiers are exact');
  });

  test('exact keeps counts and still fixes fraction precision', () => {
    const r = formatShape(shape, 'exact').relations[0];
    assert.deepEqual([r.reltuples, r.relpages, r.size_bytes!.total], [48213551, 123457, 1011359747]);
    assert.equal(r.columns[0].stats[0].null_frac, 0.1235);
  });

  test('workload counters and times', () => {
    const w: Workload = {
      source: { extension_version: '1.11', stats_reset: null, dealloc: 1234, window: { kind: 'since_reset' } },
      selection: { top: 200, candidates: 1, selected: 1 },
      statements: [
        {
          queryid: '1', kind: 'SELECT', text: 'SELECT 1 FROM t', redaction: null, calls: 7123456, total_exec_ms: 81234.56789,
          mean_exec_ms: 0.0114037, rows: 7123456, shared_blks_hit: 21987654, shared_blks_read: 3123, relations: ['public.t'],
          unresolved: [], unresolved_count: 0, selected_by: ['calls'],
        },
      ],
    };
    const a = formatWorkload(w, 'approx').statements[0];
    assert.deepEqual([a.calls, a.total_exec_ms, a.mean_exec_ms, a.rows, a.shared_blks_hit, a.shared_blks_read], [7100000, 81000, 0.011, 7100000, 22000000, 3100]);
    assert.equal(formatWorkload(w, 'approx').source!.dealloc, 1200);
    const e = formatWorkload(w, 'exact').statements[0];
    assert.deepEqual([e.calls, e.total_exec_ms, e.mean_exec_ms], [7123456, 81234.568, 0.011]);
  });
});

describe('schema validation', () => {
  const valid = () => ({
    manifest: {
      format_version: 1, created_at: '2026-10-02T00:00:00.000Z', label: 'prod', server_version_num: 180006, mode: 'shape',
      precision: 'approx', status: 'COMPLETE', partial_reasons: [], tool_version: '1.3.1',
      schema_source: { kind: 'pg_dump', pg_dump_version: '18.6' },
      files: { 'schema.sql': 'a'.repeat(64), 'shape.json': 'b'.repeat(64), 'workload.json': 'c'.repeat(64), 'redactions.json': 'd'.repeat(64) },
    },
    shape: {
      block_size: 8192, size_source: 'relpages', column_stats_source: 'pg_stats', stats_reset: { database: null },
      relations: [
        {
          schema: 'public', name: 't', kind: 'table', partition_of: null, reltuples: 10, relpages: 1, relallvisible: 0,
          size_bytes: { table: 8192, indexes: 0, total: 8192 }, activity: null, last_analyze: null,
          columns: [{ name: 'c', attnum: 1, stats: [{ inherited: false, null_frac: 0, avg_width: 4, n_distinct: -1, correlation: 1, mcv_freqs: null }] }],
        },
      ],
      indexes: [],
    },
    workload: { source: null, selection: { top: 200, candidates: 0, selected: 0 }, statements: [] as any[] },
    redactions: {
      schema: { removed_entries: {}, removed_lines: { owner: 0, restrict: 0, connect: 0 } },
      workload: {
        entries_read: 0, excluded: { not_dml: 0, text_hidden: 0, system_only: 0, no_relations: 0 }, comments_removed: 0,
        redacted: { literal: [], unparseable: [] },
      },
    },
  });

  test('a well-formed snapshot is valid', () => assert.deepEqual(validateSnapshot(valid()), []));

  test('a value-bearing statistic anywhere is rejected', () => {
    const v = valid();
    (v.shape.relations[0].columns[0].stats[0] as any).most_common_vals = ['alice@example.com'];
    assert.match(validateSnapshot(v).join('\n'), /must NOT have additional properties: most_common_vals/);
  });

  test('status and partial_reasons must agree', () => {
    const v = valid();
    v.manifest.status = 'PARTIAL';
    assert.notDeepEqual(validateSnapshot(v), []);
  });

  test('a redacted statement must not carry its text', () => {
    const v = valid();
    v.workload.statements.push({
      queryid: '5', kind: 'SELECT', text: "SELECT * FROM t WHERE email = 'alice@example.com'", redaction: 'literal', calls: 1,
      total_exec_ms: 1, mean_exec_ms: 1, rows: 1, shared_blks_hit: 0, shared_blks_read: 0, relations: [], unresolved: [],
      unresolved_count: 0, selected_by: ['calls'],
    });
    assert.match(validateSnapshot(v).join('\n'), /\/workload\/statements\/0\/text must be equal to constant/);
  });
});
