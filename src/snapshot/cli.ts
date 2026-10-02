import * as fs from 'fs';
import { parseArgs } from 'util';
import { Precision } from './format';
import { takeSnapshot } from './run';
import { SNAPSHOT_EXIT } from './types';
import { DEFAULT_TOP } from './workload';

const USAGE = `
USAGE:
  $ queryguard snapshot --label <name> [options]

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
  --precision      approx (default): counts, sizes and times rounded to 2 significant figures.
                   exact: unrounded.
  --pg-dump        pg_dump binary to use (default: the first one on PATH at least as new as
                   the server)
  --schema-from    Use this pg_dump --schema-only file instead of running pg_dump, so the
                   snapshot role needs no SELECT on any table

EXIT CODES:
  0 COMPLETE, 2 PARTIAL (artifact written, reasons in manifest.json), 1 failed (nothing written)
`;

const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/** `30s`, `5m`, `1h`, `1500ms` → milliseconds, or null if malformed or outside 1s..1h. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!m) return null;
  const ms = Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
  return ms >= 1000 && ms <= 3_600_000 ? ms : null;
}

const usageError = (message: string) => {
  console.error(`[QueryGuard] snapshot: ${message}\n${USAGE}`);
  return SNAPSHOT_EXIT.FAILED;
};

export async function runSnapshot(argv: string[]): Promise<number> {
  let values: {
    label?: string;
    out?: string;
    top?: string;
    'sample-window'?: string;
    precision?: string;
    'pg-dump'?: string;
    'schema-from'?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        label: { type: 'string' },
        out: { type: 'string', default: '.queryguard/snapshot' },
        top: { type: 'string', default: String(DEFAULT_TOP) },
        'sample-window': { type: 'string' },
        precision: { type: 'string', default: 'approx' },
        'pg-dump': { type: 'string' },
        'schema-from': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err: any) {
    return usageError(err.message);
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.label || !LABEL.test(values.label)) {
    return usageError(`--label is required (letters, digits, '.', '_', '-'; max 64)`);
  }
  const top = /^\d+$/.test(values.top!) ? Number(values.top) : NaN;
  if (!(top >= 1 && top <= 10_000)) return usageError('--top must be a whole number from 1 to 10000');
  const windowMs = values['sample-window'] === undefined ? undefined : parseDuration(values['sample-window']);
  if (windowMs === null) return usageError('--sample-window must look like 30s, 5m or 1h (1s to 1h)');
  if (values.precision !== 'approx' && values.precision !== 'exact') return usageError('--precision must be approx or exact');
  if (values['schema-from'] !== undefined) {
    if (values['pg-dump'] !== undefined) return usageError('--pg-dump has no effect with --schema-from; pass one or the other');
    if (!fs.existsSync(values['schema-from'])) return usageError(`--schema-from file not found: ${values['schema-from']}`);
  }

  try {
    const manifest = await takeSnapshot({
      label: values.label,
      out: values.out!,
      top,
      precision: values.precision as Precision,
      windowMs,
      schemaFrom: values['schema-from'],
      pgDump: values['pg-dump'],
      log: (line) => console.log(`[QueryGuard] ${line}`),
    });
    console.log(`[QueryGuard] snapshot '${manifest.label}' written to ${values.out}: ${manifest.status}`);
    for (const p of manifest.partial_reasons) console.log(`  - ${p.scope}: ${p.reason}`);
    return manifest.status === 'COMPLETE' ? SNAPSHOT_EXIT.COMPLETE : SNAPSHOT_EXIT.PARTIAL;
  } catch (err: any) {
    console.error(`[QueryGuard] snapshot failed, nothing written: ${err.message}`);
    return SNAPSHOT_EXIT.FAILED;
  }
}
