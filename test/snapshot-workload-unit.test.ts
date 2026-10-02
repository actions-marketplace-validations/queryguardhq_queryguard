// Phase 1 / item 3: the privacy path for query text, without a database.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { code, hasLiteral, lex, rebuild, statementKind } from '../src/snapshot/lexer';
import { makeResolver, relationRefs } from '../src/snapshot/relations';
import { buildWorkload, processText, Reading } from '../src/snapshot/workload';
import { parseDuration } from '../src/snapshot/cli';

const types = (sql: string) => lex(sql).tokens.map((t) => [t.type, t.text]);

describe('lexer', () => {
  test('nested block comments and line comments', () => {
    assert.deepEqual(types('/* a /* b */ c */ SELECT 1 -- x'), [
      ['comment', '/* a /* b */ c */'],
      ['word', 'SELECT'],
      ['number', '1'],
      ['comment', '-- x'],
    ]);
  });

  test('comment markers inside strings and quoted identifiers are not comments', () => {
    assert.deepEqual(types(`SELECT '--x /* y' AS "a--b/*"`), [
      ['word', 'SELECT'],
      ['string', `'--x /* y'`],
      ['word', 'AS'],
      ['quoted', '"a--b/*"'],
    ]);
  });

  test('every string form is one string token', () => {
    for (const s of [
      `'it''s'`,
      `E'it\\'s'`,
      `e'a\\\\'`,
      `E'x''y'`,
      `B'101'`,
      `X'1F'`,
      `N'abc'`,
      `U&'d\\0061t'`,
      `$$a'b"c$$`,
      `$tag$ $1 'x' $$ $tag$`,
    ]) {
      assert.deepEqual(types(s), [['string', s]], s);
    }
    assert.deepEqual(types('U&"d\\0061t"'), [['quoted', 'U&"d\\0061t"']]);
  });

  test('numbers in every form, parameters, and identifiers containing $', () => {
    for (const n of ['42', '3.14', '.5', '5.', '1e10', '1.5E-3', '0x1F', '0b101', '1_000']) {
      assert.deepEqual(types(n), [['number', n]], n);
    }
    assert.deepEqual(types('$1 $12'), [['param', '$1'], ['param', '$12']]);
    assert.deepEqual(types('a$1'), [['word', 'a$1']]);
    assert.deepEqual(types('t.col'), [['word', 't'], ['op', '.'], ['word', 'col']]);
  });

  test('anything it cannot close is a problem, never a guess', () => {
    for (const s of [`SELECT 'abc`, `SELECT "abc`, `SELECT 1 /* x /* y */`, `SELECT $$abc`, `SELECT $a$ x $b$`, `SELECT E'\\'`, 'SELECT $']) {
      assert.ok(lex(s).problem, s);
    }
  });
});

describe('literal detector', () => {
  const literal = (sql: string) => hasLiteral(code(lex(sql).tokens));
  test('normalized text has no literal', () => {
    for (const s of [
      'SELECT id FROM t WHERE email = $1',
      'SELECT * FROM t WHERE flag = true AND x IS NULL LIMIT $2',
      'SELECT id FROM t WHERE id IN ($1 /*, ... */)',
      'SELECT "col1" FROM t9 -- 42 in a comment',
    ]) {
      assert.equal(literal(s), false, s);
    }
  });
  test('any surviving string or number is a literal', () => {
    for (const s of [
      `SELECT * FROM t WHERE email = 'alice@example.com'`,
      'SELECT status, count(*) FROM t GROUP BY 1',
      'SELECT $1::varchar(10)',
      `SELECT * FROM t WHERE note = $$secret$$`,
      `SELECT * FROM t WHERE b = X'ff'`,
      'SELECT * FROM t WHERE x > .5',
    ]) {
      assert.equal(literal(s), true, s);
    }
  });
});

describe('comment removal and statement kind', () => {
  test('rebuild drops comments and collapses gaps to single spaces', () => {
    assert.equal(rebuild(lex('SELECT /* c */ id,\n   name\n  FROM t -- x').tokens), 'SELECT id, name FROM t');
    assert.equal(rebuild(lex('SELECT count(*) FROM "My Table"').tokens), 'SELECT count(*) FROM "My Table"');
  });

  test('plannable statements are classified; utility commands are not', () => {
    const cases: Array<[string, string | null]> = [
      ['select 1', 'SELECT'],
      ['(SELECT 1) UNION (SELECT 2)', 'SELECT'],
      ['VALUES ($1)', 'SELECT'],
      ['TABLE t', 'SELECT'],
      ['INSERT INTO t VALUES ($1)', 'INSERT'],
      ['UPDATE t SET a = $1', 'UPDATE'],
      ['DELETE FROM t', 'DELETE'],
      ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'MERGE'],
      ['WITH x AS (SELECT * FROM t) UPDATE t SET a = $1 FROM x', 'UPDATE'],
      ['WITH RECURSIVE r(n) AS (SELECT $1 UNION ALL SELECT n FROM r) SELECT * FROM r', 'SELECT'],
      ['WITH d AS MATERIALIZED (DELETE FROM t RETURNING *) INSERT INTO a SELECT * FROM d', 'INSERT'],
      [`COMMENT ON COLUMN t.c IS 'x'`, null],
      ['CREATE INDEX i ON t (c)', null],
      ['SET application_name = $1', null],
      ['EXPLAIN SELECT 1', null],
      ['VACUUM t', null],
    ];
    for (const [sql, want] of cases) assert.equal(statementKind(lex(sql).tokens), want, sql);
  });
});

describe('relation extraction', () => {
  const resolve = makeResolver([
    { schema: 'public', name: 'orders' },
    { schema: 'public', name: 'customers' },
    { schema: 'public', name: 'Mixed Case' },
    { schema: 'billing', name: 'invoices' },
    { schema: 'archive', name: 'invoices' },
  ]);
  const refs = (sql: string) => resolve(relationRefs(lex(sql).tokens));
  const cases: Array<[string, string[], string[]?]> = [
    ['SELECT * FROM orders', ['public.orders']],
    ['SELECT * FROM public.orders o JOIN customers c ON c.id = o.customer_id', ['public.customers', 'public.orders']],
    ['SELECT * FROM orders AS o, customers c WHERE o.c = c.id', ['public.customers', 'public.orders']],
    ['SELECT * FROM (SELECT * FROM orders) s, customers', ['public.customers', 'public.orders']],
    ['SELECT * FROM generate_series(1, $1) g, orders', ['public.orders']],
    ['SELECT extract(epoch FROM created_at), substring(x FROM $1 FOR $2) FROM orders', ['public.orders']],
    ['SELECT * FROM orders WHERE a IS DISTINCT FROM b', ['public.orders']],
    ['WITH recent AS (SELECT * FROM orders) SELECT * FROM recent JOIN customers USING (id)', ['public.customers', 'public.orders']],
    ['UPDATE orders SET x = $1 FROM customers WHERE orders.c = customers.id', ['public.customers', 'public.orders']],
    [
      'INSERT INTO orders (a, b) SELECT a, b FROM customers ON CONFLICT (a) DO UPDATE SET b = excluded.b',
      ['public.customers', 'public.orders'],
    ],
    ['DELETE FROM orders USING customers WHERE orders.c = customers.id', ['public.customers', 'public.orders']],
    [
      'MERGE INTO orders o USING customers c ON o.id = c.id WHEN MATCHED THEN UPDATE SET x = $1 WHEN NOT MATCHED THEN INSERT (id) VALUES (c.id)',
      ['public.customers', 'public.orders'],
    ],
    ['SELECT * FROM orders FOR UPDATE OF orders', ['public.orders']],
    ['SELECT * FROM ONLY orders o LEFT OUTER JOIN customers c ON true', ['public.customers', 'public.orders']],
    ['SELECT * FROM orders CROSS JOIN LATERAL jsonb_each(o.j) e', ['public.orders']],
    ['SELECT * FROM "Mixed Case"', ['public."Mixed Case"']],
    ['TABLE orders', ['public.orders']],
    ['SELECT * FROM billing.invoices', ['billing.invoices']],
    ['SELECT * FROM invoices', [], ['invoices']], // two schemas: ambiguous, not guessed
    ['SELECT * FROM nope.orders, missing', [], ['missing', 'nope.orders']],
    ['SELECT * FROM pg_class c JOIN pg_catalog.pg_namespace n ON true', []],
  ];
  for (const [sql, relations, unresolved = []] of cases) {
    test(sql, () => {
      const r = refs(sql);
      assert.deepEqual(r.relations, relations);
      assert.deepEqual(r.unresolved, unresolved);
    });
  }
  test('system catalogs and extension relations are counted, not reported', () => {
    assert.equal(refs('SELECT * FROM pg_class c JOIN pg_catalog.pg_namespace n ON true').system, 2);
    const withExt = makeResolver([{ schema: 'public', name: 'orders' }], [{ schema: 'public', name: 'pg_stat_statements' }]);
    const r = withExt(relationRefs(lex('SELECT * FROM public.pg_stat_statements s, pg_stat_statements t').tokens));
    assert.deepEqual([r.relations, r.unresolved, r.system], [[], [], 2]);
  });
});

describe('workload builder', () => {
  const resolve = makeResolver([
    { schema: 'public', name: 'orders' },
    { schema: 'public', name: 'customers' },
  ]);
  const entry = (queryid: string | null, query: string, calls: number, time = calls) => ({
    queryid,
    query,
    calls,
    total_exec_time: time,
    rows: calls,
    shared_blks_hit: calls,
    shared_blks_read: 0,
  });
  const reading = (entries: ReturnType<typeof entry>[], extra: Partial<Reading> = {}): Reading => ({
    at: 1_000_000,
    extension_version: '1.11',
    stats_reset: '2026-09-01T00:00:00.000Z',
    dealloc: 0,
    entries,
    ...extra,
  });

  test('aggregates roles, drops utility and catalog-only statements, redacts literals', () => {
    const r = buildWorkload(
      reading([
        entry('10', 'SELECT id FROM orders WHERE id = $1 /* app:web */', 70, 7),
        entry('10', 'SELECT id FROM orders WHERE id = $1', 30, 3),
        entry('-20', `SELECT * FROM orders o JOIN mystery m ON true WHERE o.ref = 'ABC-123'`, 5, 50),
        entry('30', `COMMENT ON TABLE orders IS 'secret'`, 1),
        entry('40', 'SELECT * FROM pg_catalog.pg_stat_activity', 9),
        entry('50', 'SELECT $1', 1000),
        entry('60', `SELECT * FROM customers WHERE note = 'oops`, 2),
      ]),
      { top: 10, resolve }
    );
    const w = r.workload;
    assert.deepEqual(
      w.statements.map((s) => [s.queryid, s.kind, s.text, s.calls, s.relations, s.unresolved, s.unresolved_count]),
      [
        ['-20', 'SELECT', '[redacted: literal]', 5, ['public.orders'], [], 1],
        ['10', 'SELECT', 'SELECT id FROM orders WHERE id = $1', 100, ['public.orders'], [], 0],
        ['60', 'UNKNOWN', '[redacted: unparseable]', 2, [], [], 0],
      ]
    );
    assert.equal(w.statements[1].mean_exec_ms, 0.1);
    assert.deepEqual(r.redactions.workload.excluded, { not_dml: 1, text_hidden: 0, system_only: 1, no_relations: 1 });
    assert.deepEqual(r.redactions.workload.redacted, { literal: ['-20'], unparseable: ['60'] });
    assert.equal(r.redactions.workload.comments_removed, 1);
    assert.deepEqual(r.partial, []);
    assert.deepEqual(w.source?.window, { kind: 'since_reset' });
    const json = JSON.stringify(r);
    for (const secret of ['ABC-123', 'secret', 'oops', 'app:web', 'mystery']) assert.ok(!json.includes(secret), secret);
  });

  test('one role\'s text with a literal redacts the whole statement', () => {
    const r = buildWorkload(
      reading([entry('7', 'SELECT * FROM orders WHERE id = $1', 50), entry('7', 'SELECT * FROM orders WHERE id = 99', 1)]),
      { top: 10, resolve }
    );
    assert.equal(r.workload.statements[0].text, '[redacted: literal]');
    assert.equal(r.workload.statements[0].calls, 51);
  });

  test('hidden text is excluded, counted and makes the workload PARTIAL', () => {
    const r = buildWorkload(
      reading([entry(null, '<insufficient privilege>', 5), entry('8', 'SELECT * FROM orders', 1)]),
      { top: 10, resolve }
    );
    assert.equal(r.redactions.workload.excluded.text_hidden, 1);
    assert.match(r.partial[0].reason, /pg_read_all_stats/);
    assert.equal(r.workload.statements.length, 1);
  });

  test('top N by total time unioned with top N by calls', () => {
    const r = buildWorkload(
      reading([
        entry('1', 'SELECT * FROM orders WHERE a = $1', 1000, 1), // most calls
        entry('2', 'SELECT * FROM orders WHERE b = $1', 1, 1000), // most time
        entry('3', 'SELECT * FROM orders WHERE c = $1', 10, 10), // neither
      ]),
      { top: 1, resolve }
    );
    assert.deepEqual(
      r.workload.statements.map((s) => [s.queryid, s.selected_by]),
      [
        ['1', ['calls']],
        ['2', ['total_time']],
      ]
    );
    assert.deepEqual(r.workload.selection, { top: 1, candidates: 3, selected: 2 });
  });

  test('a sampled window keeps deltas, drops idle statements and reports unmatched entries', () => {
    const before = reading(
      [
        entry('1', 'SELECT * FROM orders WHERE a = $1', 100, 100),
        entry('2', 'SELECT * FROM orders WHERE b = $1', 50, 50),
        entry('9', 'SELECT * FROM customers', 5, 5),
      ],
      { at: 1_000_000, dealloc: 3 }
    );
    const after = reading(
      [
        entry('1', 'SELECT * FROM orders WHERE a = $1', 130, 160),
        entry('2', 'SELECT * FROM orders WHERE b = $1', 50, 50),
        entry('4', 'SELECT * FROM customers WHERE x = $1', 7, 7),
      ],
      { at: 1_030_000, dealloc: 4 }
    );
    const r = buildWorkload(after, { top: 10, resolve, before });
    assert.deepEqual(
      r.workload.statements.map((s) => [s.queryid, s.calls, s.total_exec_ms]),
      [
        ['1', 30, 60],
        ['4', 7, 7],
      ]
    );
    assert.deepEqual(r.workload.source?.window, { kind: 'sampled', seconds: 30 });
    assert.deepEqual(r.workload.sampling, { new_entries: 1, evicted_entries: 1, dealloc_during_window: 1 });
    assert.deepEqual(r.partial, []);
  });

  test('a reset during the window is PARTIAL, and post-reset counts are used', () => {
    const before = reading([entry('1', 'SELECT * FROM orders', 100)]);
    const after = reading([entry('1', 'SELECT * FROM orders', 4)], { at: 1_010_000, stats_reset: '2026-10-02T00:00:00.000Z' });
    const r = buildWorkload(after, { top: 10, resolve, before });
    assert.equal(r.workload.statements[0].calls, 4);
    assert.match(r.partial[0].reason, /reset during the sample window/);
  });

  test('processText reports hidden and unparseable texts', () => {
    assert.equal(processText('<insufficient privilege>').status, 'hidden');
    assert.equal(processText(`SELECT 'abc`).status, 'unparseable');
  });
});

describe('--sample-window durations', () => {
  test('accepts 1s to 1h', () => {
    assert.equal(parseDuration('1s'), 1000);
    assert.equal(parseDuration('5m'), 300_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('1500ms'), 1500);
    for (const bad of ['0s', '999ms', '61m', '2h', '5', '5 m', '-1s', '1.5s']) assert.equal(parseDuration(bad), null, bad);
  });
});
