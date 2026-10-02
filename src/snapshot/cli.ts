import { parseArgs } from 'util';
import pkg from '../../package.json';
import { openSnapshotSession, readOnly } from './session';
import { collectShape } from './shape';
import { FORMAT_VERSION, Manifest, PartialReason, SNAPSHOT_EXIT } from './types';
import { stableStringify, writeArtifact } from './writer';

const USAGE = `
USAGE:
  $ queryguard snapshot --label <name> [--out <dir>]

  Read-only export of production's shape. Connects with the standard libpq environment
  (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE); no connection detail is
  written to the artifact.

OPTIONS:
  --label   Name for this snapshot, e.g. prod-eu (letters, digits, '.', '_', '-'; max 64)
  --out     Output directory (default: .queryguard/snapshot)

EXIT CODES:
  0 COMPLETE, 2 PARTIAL (artifact written, reasons in manifest.json), 1 failed (nothing written)
`;

const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/** Parts not collected yet. Each is reported, so the snapshot says PARTIAL instead of looking complete. */
const NOT_COLLECTED: PartialReason[] = [
  { scope: 'schema', reason: 'not collected: schema.sql generation is not implemented yet' },
  { scope: 'workload', reason: 'not collected: workload collection is not implemented yet' },
];

export async function runSnapshot(argv: string[]): Promise<number> {
  let values: { label?: string; out?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        label: { type: 'string' },
        out: { type: 'string', default: '.queryguard/snapshot' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err: any) {
    console.error(`[QueryGuard] snapshot: ${err.message}\n${USAGE}`);
    return SNAPSHOT_EXIT.FAILED;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.label || !LABEL.test(values.label)) {
    console.error(`[QueryGuard] snapshot: --label is required (letters, digits, '.', '_', '-'; max 64)\n${USAGE}`);
    return SNAPSHOT_EXIT.FAILED;
  }

  try {
    const client = await openSnapshotSession();
    let collected;
    try {
      collected = await readOnly(client, async () => {
        const { rows } = await client.query(`SELECT pg_catalog.current_setting('server_version_num')::int AS v`);
        const serverVersionNum: number = rows[0].v;
        return { serverVersionNum, ...(await collectShape(client, serverVersionNum)) };
      });
    } finally {
      await client.end();
    }
    const { serverVersionNum, shape } = collected;

    const partial = [...NOT_COLLECTED, ...collected.partial];
    const manifest: Manifest = {
      format_version: FORMAT_VERSION,
      created_at: new Date().toISOString(),
      label: values.label,
      server_version_num: serverVersionNum,
      mode: 'shape',
      status: partial.length > 0 ? 'PARTIAL' : 'COMPLETE',
      partial_reasons: partial,
      tool_version: pkg.version,
    };
    writeArtifact(values.out!, {
      'manifest.json': stableStringify(manifest),
      'shape.json': stableStringify(shape),
    });

    console.log(`[QueryGuard] snapshot '${manifest.label}' written to ${values.out}: ${manifest.status}`);
    for (const p of partial) console.log(`  - ${p.scope}: ${p.reason}`);
    return manifest.status === 'COMPLETE' ? SNAPSHOT_EXIT.COMPLETE : SNAPSHOT_EXIT.PARTIAL;
  } catch (err: any) {
    console.error(`[QueryGuard] snapshot failed, nothing written: ${err.message}`);
    return SNAPSHOT_EXIT.FAILED;
  }
}
