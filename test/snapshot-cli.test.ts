// Phase 1 / item 1: the snapshot command's argument handling and its fail-closed writer.
// None of these need a database.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshotCli } from './snapshot-harness';
import { stableStringify, writeArtifact } from '../src/snapshot/writer';

function withTmp(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-snapcli-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('snapshot arguments', () => {
  test('--help exits 0 and documents the exit codes', () =>
    withTmp((dir) => {
      const r = runSnapshotCli(['--help'], {}, dir);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /0 COMPLETE, 2 PARTIAL/);
    }));

  test('a missing or unsafe --label fails with exit 1 and writes nothing', () =>
    withTmp((dir) => {
      for (const args of [[], ['--label', 'prod db'], ['--label', '../x']]) {
        const r = runSnapshotCli(args, {}, dir);
        assert.equal(r.exitCode, 1, `${args.join(' ')}: ${r.stdout}`);
        assert.match(r.stderr, /--label/);
      }
      assert.deepEqual(fs.readdirSync(dir), []);
    }));

  test('an unknown flag fails instead of being ignored', () =>
    withTmp((dir) => {
      const r = runSnapshotCli(['--label', 'x', '--host', 'db.internal'], {}, dir);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /--host/);
    }));

  test('an unreachable server fails with exit 1 and writes nothing', () =>
    withTmp((dir) => {
      const r = runSnapshotCli(['--label', 'x'], { PGHOST: '127.0.0.1', PGPORT: '1', PGUSER: 'nobody', PGDATABASE: 'none' }, dir);
      assert.equal(r.exitCode, 1, r.stdout);
      assert.match(r.stderr, /nothing written/);
      assert.deepEqual(fs.readdirSync(dir), []);
    }));
});

describe('test matrix', () => {
  const ROOT = path.resolve(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  test('docker-compose.test.yml runs Postgres 14-18 with pg_stat_statements preloaded', () => {
    const compose = read('docker-compose.test.yml');
    assert.match(compose, /shared_preload_libraries=pg_stat_statements/);
    for (const v of [14, 15, 16, 17, 18]) {
      assert.match(compose, new RegExp(`pg${v}:\\n\\s+<<: \\*snapshot-server\\n\\s+image: postgres:${v}-alpine\\n\\s+ports: \\["54${v}:5432"\\]`));
    }
  });

  test('CI and release start the matrix before running the suite', () => {
    for (const wf of ['.github/workflows/test.yml', '.github/workflows/release.yml']) {
      assert.match(read(wf), /- run: npm run test:db:up\n\s+- run: npm test\n/, wf);
      assert.doesNotMatch(read(wf), /TEST_SNAPSHOT_PG_VERSIONS/, `${wf} must not narrow the matrix`);
    }
  });
});

describe('artifact writer', () => {
  test('replaces a previous snapshot as a whole', () =>
    withTmp((dir) => {
      const out = path.join(dir, 'snap');
      writeArtifact(out, { 'manifest.json': '{"v":1}\n', 'shape.json': '{}\n' });
      writeArtifact(out, { 'manifest.json': '{"v":2}\n' });
      assert.deepEqual(fs.readdirSync(out), ['manifest.json']);
      assert.equal(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'), '{"v":2}\n');
      assert.deepEqual(fs.readdirSync(dir), ['snap'], 'no temporary directories are left behind');
    }));

  test('refuses to replace a directory holding anything but snapshot files', () =>
    withTmp((dir) => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      assert.throws(() => writeArtifact(dir, { 'manifest.json': '{}\n' }), /refusing to replace/);
      assert.ok(fs.existsSync(path.join(dir, 'package.json')));
    }));

  test('stableStringify sorts keys at every level and ends with a newline', () => {
    assert.equal(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 2 } }), `{
  "a": {
    "c": 2,
    "d": [
      {
        "y": 2,
        "z": 1
      }
    ]
  },
  "b": 1
}
`);
  });
});
