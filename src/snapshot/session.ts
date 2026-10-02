import { Client } from 'pg';

/**
 * Production-safety limits applied to every snapshot session. A catalog read that waits on a
 * lock fails fast instead of queueing behind a migration.
 */
export const SESSION_LIMITS = {
  statement_timeout: '10s',
  lock_timeout: '1s',
  idle_in_transaction_session_timeout: '30s',
} as const;

/**
 * Connects using only the standard libpq environment (PGHOST, PGPORT, PGUSER, PGPASSWORD,
 * PGDATABASE, PGSSLMODE, ...), so no connection detail is ever a command-line argument.
 */
export async function openSnapshotSession(): Promise<Client> {
  const client = new Client({ application_name: 'queryguard-snapshot' });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    for (const [name, value] of Object.entries(SESSION_LIMITS)) {
      await client.query(`SET ${name} = '${value}'`);
    }
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
  return client;
}

/** Runs `fn` in one short REPEATABLE READ, READ ONLY transaction, so all reads share a snapshot. */
export async function readOnly<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
