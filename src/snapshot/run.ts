import * as fs from 'fs';
import { ClientConfig } from 'pg';
import pkg from '../../package.json';
import { formatShape, formatWorkload, Precision } from './format';
import { sha256 } from './load';
import { findPgDump, runPgDump } from './pgdump';
import { makeResolver } from './relations';
import { compareRelations, fillIndexExpressions, processDump } from './schema-sql';
import { openSnapshotSession, readOnly } from './session';
import { collectShape } from './shape';
import { FORMAT_VERSION, Manifest } from './types';
import { validateSnapshot } from './validate';
import { buildWorkload, emptyWorkload, readWorkload, ReadResult } from './workload';
import { stableStringify, writeArtifact } from './writer';

export interface SnapshotOptions {
  label: string;
  out: string;
  top: number;
  precision: Precision;
  /** Milliseconds between the two pg_stat_statements readings; undefined for since-reset counters. */
  windowMs?: number;
  /** A schema-only dump made elsewhere, instead of running pg_dump. */
  schemaFrom?: string;
  /** An explicit pg_dump binary instead of searching PATH. */
  pgDump?: string;
  /** Tests only; the CLI connects with the libpq environment. */
  clientConfig?: ClientConfig;
  log?: (line: string) => void;
}

const MIN_SERVER = 140000;

/**
 * Takes a snapshot and writes it atomically. Throws (and writes nothing) when the result could not
 * be trusted at all: no connection, an unsupported server, no usable schema.sql, or output that
 * fails its own schema. Anything narrower becomes a PARTIAL reason in the manifest.
 */
export async function takeSnapshot(opts: SnapshotOptions): Promise<Manifest> {
  const log = opts.log ?? (() => {});
  const client = await openSnapshotSession(opts.clientConfig);
  let collected;
  let dumpText: string;
  let pgDumpVersion: string | null = null;
  try {
    const serverVersionNum: number = (await client.query(`SELECT pg_catalog.current_setting('server_version_num')::int AS v`)).rows[0].v;
    if (serverVersionNum < MIN_SERVER) {
      throw new Error(`PostgreSQL ${Math.floor(serverVersionNum / 10000)} is not supported; snapshots need PostgreSQL 14 or newer`);
    }
    const serverMajor = Math.floor(serverVersionNum / 10000);

    if (opts.schemaFrom) {
      dumpText = fs.readFileSync(opts.schemaFrom, 'utf8');
    } else {
      const pgDump = findPgDump(serverMajor, opts.pgDump);
      log(`running pg_dump ${pgDump.version} --schema-only (${pgDump.path})`);
      dumpText = await runPgDump(pgDump);
      pgDumpVersion = pgDump.version;
    }
    const dump = processDump(dumpText);
    if (dump.dumpedFromMajor === null) throw new Error('schema file has no "-- Dumped from database version" header; is it a pg_dump file?');
    if (dump.dumpedFromMajor !== serverMajor) {
      throw new Error(`schema file was dumped from PostgreSQL ${dump.dumpedFromMajor}, but the server is PostgreSQL ${serverMajor}`);
    }
    if (opts.schemaFrom) pgDumpVersion = dump.dumpedByVersion;

    // The first reading of a sampled window is its own short transaction: nothing stays open while we wait.
    let before: ReadResult | undefined;
    if (opts.windowMs !== undefined) {
      before = await readOnly(client, () => readWorkload(client));
      log(`sampling pg_stat_statements for ${opts.windowMs / 1000}s`);
      await new Promise((r) => setTimeout(r, opts.windowMs));
    }
    const inTx = await readOnly(client, async () => ({
      ...(await collectShape(client, serverVersionNum)),
      after: await readWorkload(client),
    }));
    collected = { serverVersionNum, dump, before, ...inTx };
  } finally {
    await client.end();
  }

  const { serverVersionNum, dump, before, after, shape } = collected;
  const workload = !after.ok
    ? emptyWorkload(opts.top, after.reason)
    : before && !before.ok
      ? emptyWorkload(opts.top, before.reason)
      : buildWorkload(after.reading, {
          top: opts.top,
          resolve: makeResolver(shape.relations, collected.extensionRelations),
          before: before?.reading,
        });

  const partial = [
    ...compareRelations(dump, shape),
    ...fillIndexExpressions(dump, shape.indexes),
    ...collected.partial,
    ...workload.partial,
  ];

  const files = {
    'schema.sql': dump.text,
    'shape.json': stableStringify(formatShape(shape, opts.precision)),
    'workload.json': stableStringify(formatWorkload(workload.workload, opts.precision)),
    'redactions.json': stableStringify({ schema: dump.redactions, ...workload.redactions }),
  };
  const manifest: Manifest = {
    format_version: FORMAT_VERSION,
    created_at: new Date().toISOString(),
    label: opts.label,
    server_version_num: serverVersionNum,
    mode: 'shape',
    precision: opts.precision,
    status: partial.length > 0 ? 'PARTIAL' : 'COMPLETE',
    partial_reasons: partial,
    tool_version: pkg.version,
    schema_source: { kind: opts.schemaFrom ? 'file' : 'pg_dump', pg_dump_version: pgDumpVersion },
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)])),
  };

  const invalid = validateSnapshot({
    manifest,
    shape: JSON.parse(files['shape.json']),
    workload: JSON.parse(files['workload.json']),
    redactions: JSON.parse(files['redactions.json']),
  });
  if (invalid.length > 0) {
    throw new Error(`the snapshot does not match schema/snapshot.v1.json (a QueryGuard bug): ${invalid.slice(0, 5).join('; ')}`);
  }
  writeArtifact(opts.out, { 'manifest.json': stableStringify(manifest), ...files });
  return manifest;
}
