// Phase 1 / item 1: in the default mode, no canary may appear anywhere in the snapshot artifact.
// This test exists before the collectors do; every collector added later must keep it passing.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CANARY_CLASSES,
  Fixture,
  SNAPSHOT_VERSIONS,
  SnapshotRun,
  assertPgDump,
  assertSnapshotServer,
  canaryExposure,
  createFixture,
  listFiles,
  runSnapshotCli,
  scanForNeedles,
} from './snapshot-harness';

describe('canary scanner (negative control)', () => {
  test('finds a planted canary in a nested file, case-insensitively, and names it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-scan-'));
    try {
      fs.mkdirSync(path.join(dir, 'nested'));
      fs.writeFileSync(path.join(dir, 'clean.json'), '{"ok": true}\n');
      fs.writeFileSync(path.join(dir, 'nested', 'leaky.json'), '{"vals": ["QGCANARYSTATUS0123456789"]}\n');
      const leaks = scanForNeedles(dir, { status: 'qgcanarystatus0123456789', email: 'qgcanaryemail0123456789' });
      assert.deepEqual(
        leaks.map((l) => [l.file, l.label]),
        [[path.join('nested', 'leaky.json'), 'status']]
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing directory is an error, not a clean scan', () => {
    assert.throws(() => scanForNeedles(path.join(os.tmpdir(), 'qg-does-not-exist-7f3a'), { x: 'y' }));
  });
});

for (const version of SNAPSHOT_VERSIONS) {
  describe(`Postgres ${version}: default-mode snapshot leaks nothing`, () => {
    let fx: Fixture;
    let cwd: string;
    let out: string;
    let run: SnapshotRun;

    before(async () => {
      await assertSnapshotServer(version);
      assertPgDump();
      fx = await createFixture(version);
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-snap-'));
      out = path.join(cwd, '.queryguard', 'snapshot');
      run = runSnapshotCli(['--label', 'canary-test'], fx.env, cwd);
    });

    after(async () => {
      await fx?.cleanup();
      if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    });

    test('positive control: the canaries really are where a careless exporter would find them', async () => {
      const exposed = await canaryExposure(fx);
      for (const cls of CANARY_CLASSES) {
        if (cls === 'query_literal' || cls === 'query_literal_write') continue; // normalized by Postgres
        assert.ok(exposed[cls], `canary '${cls}' should be visible to a superuser; the fixture is not testing anything`);
      }
    });

    test('the snapshot wrote an artifact, so the scan below is not vacuous', () => {
      assert.ok(run.exitCode === 0 || run.exitCode === 2, `exit ${run.exitCode}\n${run.stdout}\n${run.stderr}`);
      const files = listFiles(out);
      assert.ok(files.includes('manifest.json'), `files: ${files.join(', ')}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
      assert.equal(manifest.label, 'canary-test');
      assert.equal(Math.floor(manifest.server_version_num / 10000), version);
      assert.equal(manifest.status, run.exitCode === 0 ? 'COMPLETE' : 'PARTIAL');
    });

    test('no canary appears anywhere in the artifact', () => {
      const leaks = scanForNeedles(out, fx.canaries);
      assert.deepEqual(leaks, [], `leaked: ${leaks.map((l) => `${l.label} in ${l.file}: …${l.context}…`).join('\n')}`);
    });

    test('inspect accepts the artifact, and its report carries no canary either', () => {
      const r = runSnapshotCli(['inspect', out], {}, cwd);
      assert.equal(r.exitCode, run.exitCode, r.stderr);
      assert.match(r.stdout, /QueryGuard snapshot: canary-test/);
      assert.match(r.stdout, /public\.customers/);
      for (const [cls, canary] of Object.entries(fx.canaries)) assert.ok(!r.stdout.includes(canary), cls);
    });

    test('no connection detail appears in the artifact', () => {
      const leaks = scanForNeedles(out, {
        database: fx.database,
        role: fx.role,
        password: fx.password,
        host: fx.env.PGHOST,
      });
      assert.deepEqual(leaks, [], `leaked: ${leaks.map((l) => `${l.label} in ${l.file}`).join(', ')}`);
    });
  });
}
