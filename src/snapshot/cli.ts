import { parseArgs } from 'util';
import pkg from '../../package.json';
import { openSnapshotSession, readOnly } from './session';
import { collectShape } from './shape';
import { makeResolver } from './relations';
import { buildWorkload, DEFAULT_TOP, emptyWorkload, readWorkload, ReadResult } from './workload';
import { FORMAT_VERSION, Manifest, PartialReason, SNAPSHOT_EXIT } from './types';
import { stableStringify, writeArtifact } from './writer';

const USAGE = `
USAGE:
  $ queryguard snapshot --label <name> [--out <dir>] [--top <n>] [--sample-window <duration>]

  Read-only export of production's shape. Connects with the standard libpq environment
  (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE); no connection detail is
  written to the artifact.

OPTIONS:
  --label          Name for this snapshot, e.g. prod-eu (letters, digits, '.', '_', '-'; max 64)
  --out            Output directory (default: .queryguard/snapshot)
  --top            Statements kept from pg_stat_statements: the top N by total execution
                   time plus the top N by calls (default: 200)
  --sample-window  Read pg_stat_statements twice this far apart (e.g. 30s, 5m; 1s to 1h) and
                   keep the difference, so counts reflect current traffic rather than
                   everything since the last reset. No transaction is held open meanwhile.

EXIT CODES:
  0 COMPLETE, 2 PARTIAL (artifact written, reasons in manifest.json), 1 failed (nothing written)
`;

const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/** Parts not collected yet. Each is reported, so the snapshot says PARTIAL instead of looking complete. */
const NOT_COLLECTED: PartialReason[] = [
  { scope: 'schema', reason: 'not collected: schema.sql generation is not implemented yet' },
];

/** `30s`, `5m`, `1h`, `1500ms` → milliseconds, or null if malformed or outside 1s..1h. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!m) return null;
  const ms = Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
  return ms >= 1000 && ms <= 3_600_000 ? ms : null;
}

export async function runSnapshot(argv: string[]): Promise<number> {
  let values: { label?: string; out?: string; top?: string; 'sample-window'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        label: { type: 'string' },
        out: { type: 'string', default: '.queryguard/snapshot' },
        top: { type: 'string', default: String(DEFAULT_TOP) },
        'sample-window': { type: 'string' },
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
  const top = /^\d+$/.test(values.top!) ? Number(values.top) : NaN;
  if (!(top >= 1 && top <= 10_000)) {
    console.error(`[QueryGuard] snapshot: --top must be a whole number from 1 to 10000\n${USAGE}`);
    return SNAPSHOT_EXIT.FAILED;
  }
  const windowMs = values['sample-window'] === undefined ? undefined : parseDuration(values['sample-window']);
  if (windowMs === null) {
    console.error(`[QueryGuard] snapshot: --sample-window must look like 30s, 5m or 1h (1s to 1h)\n${USAGE}`);
    return SNAPSHOT_EXIT.FAILED;
  }

  try {
    const client = await openSnapshotSession();
    let collected;
    try {
      // The first reading of a sampled window is its own short transaction: nothing is held
      // open on the server while we wait.
      let before: ReadResult | undefined;
      if (windowMs !== undefined) {
        before = await readOnly(client, () => readWorkload(client));
        console.log(`[QueryGuard] sampling pg_stat_statements for ${values['sample-window']}...`);
        await new Promise((r) => setTimeout(r, windowMs));
      }
      collected = await readOnly(client, async () => {
        const { rows } = await client.query(`SELECT pg_catalog.current_setting('server_version_num')::int AS v`);
        const serverVersionNum: number = rows[0].v;
        const shapeResult = await collectShape(client, serverVersionNum);
        return { serverVersionNum, ...shapeResult, before, after: await readWorkload(client) };
      });
    } finally {
      await client.end();
    }
    const { serverVersionNum, shape, before, after } = collected;

    const workloadResult =
      !after.ok
        ? emptyWorkload(top, after.reason)
        : before && !before.ok
          ? emptyWorkload(top, before.reason)
          : buildWorkload(after.reading, {
              top,
              resolve: makeResolver(shape.relations, collected.extensionRelations),
              before: before?.reading,
            });

    const partial = [...NOT_COLLECTED, ...collected.partial, ...workloadResult.partial];
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
      'workload.json': stableStringify(workloadResult.workload),
      'redactions.json': stableStringify(workloadResult.redactions),
    });

    console.log(`[QueryGuard] snapshot '${manifest.label}' written to ${values.out}: ${manifest.status}`);
    for (const p of partial) console.log(`  - ${p.scope}: ${p.reason}`);
    return manifest.status === 'COMPLETE' ? SNAPSHOT_EXIT.COMPLETE : SNAPSHOT_EXIT.PARTIAL;
  } catch (err: any) {
    console.error(`[QueryGuard] snapshot failed, nothing written: ${err.message}`);
    return SNAPSHOT_EXIT.FAILED;
  }
}
