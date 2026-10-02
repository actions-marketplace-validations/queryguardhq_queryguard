import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** How long pg_dump may wait for each table's ACCESS SHARE lock before giving up (fails the run). */
export const LOCK_WAIT_TIMEOUT_MS = 5000;
/** Upper bound on the whole pg_dump run. */
const DUMP_TIMEOUT_MS = 10 * 60 * 1000;

export interface PgDump {
  path: string;
  /** e.g. "18.0" */
  version: string;
  major: number;
}

/** The version a pg_dump binary reports, or null if it is not a runnable pg_dump. */
export function pgDumpVersion(binary: string): { version: string; major: number } | null {
  const res = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(res.stdout ?? '');
  if (res.status !== 0 || !m) return null;
  return { version: m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`, major: Number(m[1]) };
}

function installHint(serverMajor: number): string {
  return (
    `Install the PostgreSQL ${serverMajor} (or newer) client tools and put pg_dump on PATH, ` +
    `or pass --pg-dump /path/to/pg_dump. For example: Debian/Ubuntu with the PGDG repository: ` +
    `apt-get install postgresql-client-${serverMajor}; macOS: brew install libpq (then add its bin directory to PATH). ` +
    `pg_dump can dump servers of its own major version or older, never newer.`
  );
}

/**
 * Finds a pg_dump whose major version is at least the server's: `explicit` if given (and then only
 * that one), otherwise the first compatible one on PATH. Throws with install instructions otherwise;
 * there is no fallback.
 */
export function findPgDump(serverMajor: number, explicit?: string): PgDump {
  const candidates = explicit
    ? [explicit]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'))
        .filter((p) => fs.existsSync(p));

  const seen: string[] = [];
  for (const candidate of candidates) {
    const v = pgDumpVersion(candidate);
    if (!v) {
      seen.push(`${candidate} (not a runnable pg_dump)`);
      continue;
    }
    if (v.major >= serverMajor) return { path: candidate, ...v };
    seen.push(`${candidate} (version ${v.version})`);
  }
  const found = seen.length > 0 ? `Found only: ${seen.join(', ')}. ` : explicit ? '' : 'No pg_dump on PATH. ';
  throw new Error(`no pg_dump compatible with the PostgreSQL ${serverMajor} server. ${found}${installHint(serverMajor)}`);
}

/**
 * Runs `pg_dump --schema-only` against the libpq environment, read-only, with a bounded wait for
 * table locks. Everything that could carry role names, connection strings or free text is left out
 * by flag; scrubbing afterwards is a second line of defense.
 */
export function runPgDump(dump: PgDump): Promise<string> {
  const args = [
    '--schema-only',
    '--no-owner',
    '--no-privileges',
    '--no-publications',
    '--no-subscriptions',
    '--no-security-labels',
    '--no-tablespaces',
    '--no-comments',
    `--lock-wait-timeout=${LOCK_WAIT_TIMEOUT_MS}`,
  ];
  const env = {
    ...process.env,
    PGAPPNAME: 'queryguard-snapshot',
    PGOPTIONS: `${process.env.PGOPTIONS ?? ''} -c default_transaction_read_only=on`.trim(),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(dump.path, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pg_dump did not finish within ${DUMP_TIMEOUT_MS / 60000} minutes`));
    }, DUMP_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${dump.path}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`pg_dump failed (exit ${code}): ${Buffer.concat(err).toString('utf8').trim()}`));
    });
  });
}
