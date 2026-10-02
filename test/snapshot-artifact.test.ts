// Phase 1 / item 4: the artifact writer, end to end through the CLI, on Postgres 14-18.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Fixture,
  SNAPSHOT_VERSIONS,
  assertPgDump,
  assertSnapshotServer,
  createFixture,
  runSnapshotCli,
  runTestPgDump,
  scanForNeedles,
} from './snapshot-harness';
import { loadSnapshot, sha256 } from '../src/snapshot/load';
import { sig2 } from '../src/snapshot/format';

const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const json = (dir: string, f: string) => JSON.parse(read(dir, f));

/** Every measurement in shape.json and workload.json, with its path. */
function measurements(shape: any, workload: any): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const add = (p: string, v: unknown) => typeof v === 'number' && out.push([p, v]);
  for (const r of shape.relations) {
    const at = `relations/${r.name}`;
    for (const k of ['reltuples', 'relpages', 'relallvisible']) add(`${at}/${k}`, r[k]);
    for (const [k, v] of Object.entries(r.size_bytes ?? {})) add(`${at}/size_bytes/${k}`, v);
    for (const [k, v] of Object.entries(r.activity ?? {})) add(`${at}/activity/${k}`, v);
    for (const c of r.columns) {
      for (const s of c.stats) {
        add(`${at}/${c.name}/avg_width`, s.avg_width);
        if (s.n_distinct > 0) add(`${at}/${c.name}/n_distinct`, s.n_distinct);
      }
    }
  }
  for (const i of shape.indexes) {
    add(`indexes/${i.name}/size_bytes`, i.size_bytes);
    add(`indexes/${i.name}/idx_scan`, i.idx_scan);
  }
  for (const s of workload.statements) {
    for (const k of ['calls', 'total_exec_ms', 'mean_exec_ms', 'rows', 'shared_blks_hit', 'shared_blks_read']) {
      add(`statements/${s.queryid}/${k}`, s[k]);
    }
  }
  return out;
}

for (const version of SNAPSHOT_VERSIONS) {
  describe(`Postgres ${version}: artifact writer`, () => {
    let fx: Fixture;
    let tmp: string;
    let first: string;
    const dir = (name: string) => path.join(tmp, name);
    const run = (name: string, args: string[] = [], env: Record<string, string> = {}) =>
      runSnapshotCli(['--label', 'artifact-test', '--out', dir(name), ...args], { ...fx.env, ...env }, tmp);

    before(async () => {
      await assertSnapshotServer(version);
      assertPgDump();
      fx = await createFixture(version);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-artifact-'));
      first = dir('first');
      const r = run('first');
      assert.equal(r.exitCode, 0, `${r.stdout}\n${r.stderr}`);
    });

    after(async () => {
      await fx?.cleanup();
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('a healthy run is COMPLETE, validates on load, and records how schema.sql was made', () => {
      const loaded = loadSnapshot(first);
      assert.ok(loaded.ok, loaded.ok ? '' : loaded.errors.join('\n'));
      const m = loaded.snapshot.manifest;
      assert.equal(m.status, 'COMPLETE');
      assert.deepEqual(m.partial_reasons, []);
      assert.equal(m.precision, 'approx');
      assert.equal(m.schema_source.kind, 'pg_dump');
      assert.match(m.schema_source.pg_dump_version ?? '', /^1[89]\.\d+$/);
      assert.deepEqual(Object.keys(m.files).sort(), ['redactions.json', 'schema.sql', 'shape.json', 'workload.json']);
      assert.deepEqual(fs.readdirSync(first).sort(), ['manifest.json', 'redactions.json', 'schema.sql', 'shape.json', 'workload.json']);
    });

    test('schema.sql is a scrubbed schema-only dump, and fills in index expressions', () => {
      const sql = read(first, 'schema.sql');
      assert.match(sql, /CREATE TABLE public\.customers \(/);
      assert.match(sql, /CREATE INDEX customers_lower_email_idx ON public\.customers USING btree \(lower\(email\)\);/);
      for (const absent of ['OWNER TO', '\\restrict', 'COMMENT ON', 'Dumped from', 'COPY ', fx.role, fx.database]) {
        assert.ok(!sql.includes(absent), absent);
      }
      const index = json(first, 'shape.json').indexes.find((i: any) => i.name === 'customers_lower_email_idx');
      assert.deepEqual(index.keys, [{ expression: 'lower(email)' }]);
    });

    test('a refresh of an unchanged database differs only in created_at', () => {
      // The first run's own statements become pg_stat_statements entries, so compare two later runs.
      assert.ok([0, 2].includes(run('second').exitCode!));
      assert.ok([0, 2].includes(run('third').exitCode!));
      for (const f of ['schema.sql', 'shape.json', 'workload.json', 'redactions.json']) {
        assert.equal(read(dir('third'), f), read(dir('second'), f), f);
      }
      const [a, b] = [json(dir('second'), 'manifest.json'), json(dir('third'), 'manifest.json')];
      assert.notEqual(a.created_at, b.created_at);
      assert.deepEqual({ ...a, created_at: '' }, { ...b, created_at: '' });
    });

    test('approx rounds every measurement to 2 significant figures; exact keeps them', () => {
      const r = run('exact', ['--precision', 'exact']);
      assert.ok([0, 2].includes(r.exitCode!), r.stderr);
      const approx = measurements(json(first, 'shape.json'), json(first, 'workload.json'));
      assert.ok(approx.length > 50, 'enough values to make the check meaningful');
      for (const [p, v] of approx) assert.equal(sig2(v), v, `${p} = ${v}`);

      const exactShape = json(dir('exact'), 'shape.json');
      assert.equal(json(dir('exact'), 'manifest.json').precision, 'exact');
      const exactCustomers = exactShape.relations.find((x: any) => x.name === 'customers');
      const approxCustomers = json(first, 'shape.json').relations.find((x: any) => x.name === 'customers');
      assert.equal(approxCustomers.size_bytes.total, sig2(exactCustomers.size_bytes.total));
      assert.equal(exactCustomers.size_bytes.total % exactShape.block_size, 0, 'exact: whole pages');
    });

    test('no pg_dump, or one older than the server: exit 1 with instructions, nothing written', () => {
      const empty = fs.mkdtempSync(path.join(tmp, 'emptybin-'));
      const none = run('none', [], { PATH: empty });
      assert.equal(none.exitCode, 1);
      assert.match(none.stderr, /No pg_dump on PATH/);
      assert.match(none.stderr, new RegExp(`postgresql-client-${version}`));
      assert.ok(!fs.existsSync(dir('none')));

      const old = path.join(empty, 'pg_dump');
      fs.writeFileSync(old, '#!/bin/sh\necho "pg_dump (PostgreSQL) 13.4"\n', { mode: 0o755 });
      const tooOld = run('old', [], { PATH: empty });
      assert.equal(tooOld.exitCode, 1);
      assert.match(tooOld.stderr, /version 13\.4/);
      const explicit = run('old', ['--pg-dump', old]);
      assert.equal(explicit.exitCode, 1, 'an explicit --pg-dump is not second-guessed');
      assert.ok(!fs.existsSync(dir('old')));
    });

    test('pg_dump waits a bounded time for a table lock, then fails and keeps the previous snapshot', async () => {
      fs.cpSync(first, dir('kept'), { recursive: true });
      const before = read(dir('kept'), 'manifest.json');
      const holder = await fx.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE customers IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        const r = run('kept');
        assert.equal(r.exitCode, 1, r.stdout);
        assert.match(r.stderr, /pg_dump failed.*lock/is);
        assert.ok(Date.now() - started < 30_000);
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      assert.equal(read(dir('kept'), 'manifest.json'), before);
    });

    test('--schema-from: a dump made elsewhere is checked and scrubbed the same way', () => {
      // Default pg_dump flags: owners, privileges and the canary column comment are all in it.
      const file = path.join(tmp, 'elsewhere.sql');
      fs.writeFileSync(file, runTestPgDump(['--schema-only'], fx.env));
      assert.match(read(tmp, 'elsewhere.sql'), new RegExp(fx.canaries.column_comment));

      const r = run('from-file', ['--schema-from', file]);
      assert.equal(r.exitCode, 0, `${r.stdout}\n${r.stderr}`);
      const m = json(dir('from-file'), 'manifest.json');
      assert.equal(m.schema_source.kind, 'file');
      assert.match(m.schema_source.pg_dump_version, /^1[89]\.\d+$/);
      const red = json(dir('from-file'), 'redactions.json').schema;
      assert.ok(red.removed_entries.COMMENT >= 1, JSON.stringify(red));
      assert.ok(red.removed_lines.owner >= 1, JSON.stringify(red));
      const leaks = scanForNeedles(dir('from-file'), { ...fx.canaries, role: fx.role, database: fx.database });
      assert.deepEqual(leaks.map((l) => `${l.label} in ${l.file}`), []);
    });

    test('--schema-from refuses data, another major version, and a missing file', () => {
      const withData = path.join(tmp, 'with-data.sql');
      fs.writeFileSync(withData, runTestPgDump([], fx.env));
      const r = run('data', ['--schema-from', withData]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /contains data/);
      assert.ok(!fs.existsSync(dir('data')));

      const other = path.join(tmp, 'other.sql');
      fs.writeFileSync(other, '--\n-- PostgreSQL database dump\n--\n\n-- Dumped from database version 13.1\n');
      const v = run('other', ['--schema-from', other]);
      assert.equal(v.exitCode, 1);
      assert.match(v.stderr, new RegExp(`dumped from PostgreSQL 13, but the server is PostgreSQL ${version}`));

      assert.equal(run('missing', ['--schema-from', path.join(tmp, 'nope.sql')]).exitCode, 1);
    });

    test('a schema file that no longer matches the catalog makes the snapshot PARTIAL', async () => {
      const file = path.join(tmp, 'stale.sql');
      fs.writeFileSync(file, runTestPgDump(['--schema-only'], fx.env));
      const c = await fx.connect();
      try {
        await c.query('CREATE TABLE late_table (id int)');
        const r = run('stale', ['--schema-from', file]);
        assert.equal(r.exitCode, 2, r.stderr);
        const m = json(dir('stale'), 'manifest.json');
        assert.ok(
          m.partial_reasons.some((p: any) => p.scope === 'schema' && /missing 1 relation\(s\) the catalog has: public\.late_table/.test(p.reason)),
          JSON.stringify(m.partial_reasons)
        );
      } finally {
        await c.query('DROP TABLE IF EXISTS late_table');
        await c.end();
      }
    });

    test('the loader refuses edited, extra, missing or out-of-schema files', () => {
      const copy = (name: string) => {
        fs.cpSync(first, dir(name), { recursive: true });
        return dir(name);
      };
      const errors = (d: string) => {
        const r = loadSnapshot(d);
        assert.equal(r.ok, false);
        return r.ok ? '' : r.errors.join('\n');
      };

      const edited = copy('edited');
      fs.appendFileSync(path.join(edited, 'schema.sql'), '-- edited\n');
      assert.match(errors(edited), /schema\.sql does not match its SHA-256/);

      const extra = copy('extra');
      fs.writeFileSync(path.join(extra, 'stats.sql'), 'SELECT 1;\n');
      assert.match(errors(extra), /stats\.sql is not listed in manifest\.json/);

      const missing = copy('missing');
      fs.rmSync(path.join(missing, 'workload.json'));
      assert.match(errors(missing), /workload\.json is listed in manifest\.json but missing/);

      // A value smuggled in with a matching hash still fails the schema.
      const smuggled = copy('smuggled');
      const shape = json(smuggled, 'shape.json');
      shape.relations[0].columns[0].stats.push({ ...shape.relations[0].columns[0].stats[0], most_common_vals: ['x'] });
      const text = JSON.stringify(shape);
      fs.writeFileSync(path.join(smuggled, 'shape.json'), text);
      const manifest = json(smuggled, 'manifest.json');
      manifest.files['shape.json'] = sha256(text);
      fs.writeFileSync(path.join(smuggled, 'manifest.json'), JSON.stringify(manifest));
      assert.match(errors(smuggled), /schema: .*most_common_vals/);

      const future = copy('future');
      const fm = json(future, 'manifest.json');
      fm.format_version = 2;
      fs.writeFileSync(path.join(future, 'manifest.json'), JSON.stringify(fm));
      assert.match(errors(future), /unsupported format_version 2/);
    });
  });
}
