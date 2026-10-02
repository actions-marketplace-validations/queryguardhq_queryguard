import { Client, ClientConfig } from 'pg';

/** The part of a pg Client the collectors use, so tests can observe every statement sent. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

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
 * `config` exists for tests; the CLI never passes it.
 */
export async function openSnapshotSession(config: ClientConfig = {}): Promise<Client> {
  const client = new Client({ ...config, application_name: 'queryguard-snapshot' });
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
export async function readOnly<T>(client: Queryable, fn: () => Promise<T>): Promise<T> {
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

/** Runs `fn` under a savepoint: if it fails, its statements are undone and the transaction stays usable. */
export async function withSavepoint<T>(db: Queryable, name: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await db.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await db.query(`RELEASE SAVEPOINT ${name}`);
    throw err;
  }
}
