// Phase 1 / item 3: workload collection from pg_stat_statements, on Postgres 14-18.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClientConfig } from 'pg';
import {
  Fixture,
  SNAPSHOT_VERSIONS,
  assertSnapshotServer,
  createBareDatabase,
  createFixture,
  runSnapshotCli,
} from './snapshot-harness';
import { openSnapshotSession, Queryable, readOnly } from '../src/snapshot/session';
import { collectShape } from '../src/snapshot/shape';
import { makeResolver } from '../src/snapshot/relations';
import { buildWorkload, readWorkload, Reading, WorkloadResult } from '../src/snapshot/workload';

interface Collected {
  result: WorkloadResult;
  statements: string[];
}

/** What the CLI does in one transaction, in-process, recording every statement sent. */
async function collect(config: ClientConfig, earlier?: Reading): Promise<Collected> {
  const client = await openSnapshotSession(config);
  const statements: string[] = [];
  const db: Queryable = {
    query: (text, values) => {
      statements.push(text);
      return client.query(text, values as any[]);
    },
  };
  try {
    const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
    const result = await readOnly(db, async () => {
      const shape = await collectShape(db, version);
      const read = await readWorkload(db);
      if (!read.ok) throw new Error(read.reason);
      return buildWorkload(read.reading, {
        top: 200,
        resolve: makeResolver(shape.shape.relations, shape.extensionRelations),
        before: earlier,
      });
    });
    return { result, statements };
  } finally {
    await client.end();
  }
}

async function reading(config: ClientConfig): Promise<Reading> {
  const client = await openSnapshotSession(config);
  try {
    const r = await readOnly(client, () => readWorkload(client));
    if (!r.ok) throw new Error(r.reason);
    return r.reading;
  } finally {
    await client.end();
  }
}

for (const version of SNAPSHOT_VERSIONS) {
  describe(`Postgres ${version}: workload collection`, () => {
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

    const statement = (text: string) => {
      const s = owner.result.workload.statements.find((x) => x.text === text);
      assert.ok(s, `missing: ${text}\nhave:\n${owner.result.workload.statements.map((x) => x.text).join('\n')}`);
      return s!;
    };

    test('application statements: normalized, comments removed, relations resolved', () => {
      const lookup = statement('SELECT id FROM customers WHERE email = $1');
      assert.equal(lookup.kind, 'SELECT');
      assert.equal(lookup.calls, 5);
      assert.deepEqual(lookup.relations, ['public.customers']);
      assert.equal(lookup.redaction, null);

      assert.deepEqual(statement('SELECT count(*) FROM orders WHERE status = $1').relations, ['public.orders']);
      assert.deepEqual(
        statement('SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.id = $1').relations,
        ['public.customers', 'public.orders']
      );
      assert.equal(statement('UPDATE orders SET status = status WHERE note = $1').kind, 'UPDATE');
      assert.ok(owner.result.redactions.workload.comments_removed >= 2);
    });

    test('a literal that survives normalization redacts the text but keeps the counters and the table', () => {
      const s = owner.result.workload.statements.find(
        (x) => x.redaction === 'literal' && x.relations.join() === 'public.orders' && x.calls === 5
      );
      assert.ok(s, 'the GROUP BY 1 statement');
      assert.equal(s!.text, '[redacted: literal]');
      assert.ok(owner.result.redactions.workload.redacted.literal.includes(s!.queryid));
    });

    test('an unresolvable reference is listed, not guessed', () => {
      const s = statement('SELECT count(*) FROM active_customers');
      assert.deepEqual(s.relations, []);
      assert.deepEqual(s.unresolved, ['active_customers']);
    });

    test('utility and catalog-only statements are excluded and counted', () => {
      const texts = owner.result.workload.statements.map((s) => s.text);
      assert.ok(!texts.some((t) => /^(COMMENT|CREATE|ANALYZE|SET)\b/i.test(t)), texts.join('\n'));
      assert.ok(!texts.some((t) => /pg_stat_statements|pg_catalog/.test(t)), 'our own reads are not workload');
      assert.ok(owner.result.redactions.workload.excluded.not_dml >= 1);
      assert.ok(owner.result.redactions.workload.excluded.system_only >= 1);
      const json = JSON.stringify(owner.result);
      for (const [cls, canary] of Object.entries(fx.canaries)) assert.ok(!json.includes(canary), `canary ${cls}`);
    });

    test('records the window the counters cover', () => {
      const src = owner.result.workload.source!;
      assert.match(src.extension_version, /^1\.\d+$/);
      assert.deepEqual(src.window, { kind: 'since_reset' });
      assert.equal(typeof src.dealloc, 'number');
      assert.deepEqual(owner.result.partial, []);
    });

    test('reads only catalogs and pg_stat_statements, schema-qualified', () => {
      for (const s of owner.statements) {
        for (const m of s.matchAll(/\b(?:FROM|JOIN)\s+([^\s(]+)/gi)) {
          assert.match(m[1], /^(pg_catalog\.[a-z_]+|public\.pg_stat_statements(_info)?)$/, `reads ${m[1]} in: ${s}`);
        }
      }
    });

    test("without pg_read_all_stats, other roles' text is hidden and the workload is PARTIAL", async () => {
      const login = await fx.createRole();
      const r = await collect(fx.config(login));
      assert.ok(r.result.redactions.workload.excluded.text_hidden > 0);
      assert.ok(r.result.partial.some((p) => p.scope === 'workload' && /pg_read_all_stats/.test(p.reason)));
      assert.ok(!r.result.workload.statements.some((s) => s.text.includes('customers')));
    });

    test('a sampled window keeps only what ran during it', async () => {
      const first = await reading(fx.config());
      const c = await fx.connect();
      try {
        for (let i = 0; i < 7; i++) await c.query('SELECT id FROM orders WHERE id = 7');
      } finally {
        await c.end();
      }
      const r = await collect(fx.config(), first);
      const s = r.result.workload.statements.find((x) => x.text === 'SELECT id FROM orders WHERE id = $1');
      assert.equal(s?.calls, 7);
      assert.ok(!r.result.workload.statements.some((x) => x.text === 'SELECT id FROM customers WHERE email = $1'), 'idle in the window');
      assert.equal(r.result.workload.source!.window.kind, 'sampled');
    });

    test('CLI: --sample-window writes a sampled workload', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sample-'));
      try {
        const run = runSnapshotCli(['--label', 'sampled', '--sample-window', '1s', '--top', '50'], fx.env, cwd);
        assert.ok(run.exitCode === 0 || run.exitCode === 2, run.stderr);
        const w = JSON.parse(fs.readFileSync(path.join(cwd, '.queryguard/snapshot/workload.json'), 'utf8'));
        assert.equal(w.source.window.kind, 'sampled');
        assert.ok(w.source.window.seconds >= 1);
        assert.equal(w.selection.top, 50);
        assert.ok(fs.existsSync(path.join(cwd, '.queryguard/snapshot/redactions.json')));
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('CLI: without pg_stat_statements the workload is empty and the snapshot PARTIAL', async () => {
      const bare = await createBareDatabase(version);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-bare-'));
      try {
        const run = runSnapshotCli(['--label', 'bare'], bare.env, cwd);
        assert.equal(run.exitCode, 2, run.stderr);
        const out = path.join(cwd, '.queryguard/snapshot');
        const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
        assert.ok(
          manifest.partial_reasons.some((p: any) => p.scope === 'workload' && /pg_stat_statements is not installed/.test(p.reason)),
          JSON.stringify(manifest.partial_reasons)
        );
        const w = JSON.parse(fs.readFileSync(path.join(out, 'workload.json'), 'utf8'));
        assert.equal(w.source, null);
        assert.deepEqual(w.statements, []);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        await bare.cleanup();
      }
    });
  });
}
