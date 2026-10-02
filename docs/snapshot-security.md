# QueryGuard snapshots: a guide for security reviewers

`queryguard snapshot` exports the *shape* of a production PostgreSQL database into a directory that is committed to the repository. The QueryGuard GitHub Action reads that directory to tell reviewers what a migration touches in production: approximate rows, size and traffic.

This page explains what leaves production, what never does, how that is enforced and tested, which grants the snapshot needs, and how to review a refresh.

Design notes, and the Postgres behavior each rule depends on (with documentation and source references), are in [docs/design/snapshot.md](design/snapshot.md).

## The trust boundary

There are two separate jobs, and only one of them can reach production:

| | Refresh job | PR check (the Action) |
| :--- | :--- | :--- |
| Runs | Somewhere with production access: a scheduled job on a bastion, or a self-hosted runner inside your network | On every pull request, on any runner |
| Holds production credentials | Yes: a dedicated read-only role (below) | **Never.** It reads `.queryguard/snapshot/` from the checkout. |
| Network | The production database only. No other host, no telemetry | GitHub's API, to post the PR comment |
| Output | A pull request that updates `.queryguard/snapshot/`, reviewed like any change | A PR comment |

Every refresh therefore goes through code review before the PR check uses it. [`docs/examples/snapshot-refresh.yml`](examples/snapshot-refresh.yml) is a refresh workflow to start from.

## What is collected

| File | Contents |
| :--- | :--- |
| `manifest.json` | Format version, time taken, your `--label`, server version, mode, precision, status (COMPLETE, or PARTIAL with reasons), how `schema.sql` was made, the SHA-256 of every other file. In full mode, the allow-listed columns. |
| `schema.sql` | `pg_dump --schema-only`, scrubbed (below): table, column, index, view and function definitions. |
| `shape.json` | Per table: estimated rows, pages, size, insert/update/delete and scan counters, last analyze. Per index: columns or expressions, unique, valid, size, scans. Per column: null fraction, average width, number of distinct values, correlation, and the *frequencies* of the most common values without the values. |
| `workload.json` | The busiest normalized statements from `pg_stat_statements` (top N by total time and by calls): text with constants as `$1`, counters, and the tables each touches. |
| `redactions.json` | What was withheld or removed, and why: counts and statement IDs, never content. |
| `stats.sql` | Full mode only (below). |

**Rounding.** By default every measurement is rounded to 2 significant figures (48,213,551 rows becomes 48,000,000), because exact counts can be business-sensitive. Fractions keep 4 decimals. `--precision exact` turns rounding off; the manifest records which was used.

## What is never collected

* **Row data.** In the default (shape) mode, no value from any row leaves production. The value-bearing statistics columns (`most_common_vals`, `histogram_bounds`, `most_common_elems`, `most_common_elem_freqs`, `elem_count_histogram`, `range_*`) are **not even selected**, so they never reach QueryGuard's memory.
* **Connection details.** No host, port, user, password, connection string or database name. QueryGuard connects only through the standard libpq environment (`PGHOST`, `PGUSER`, `PGPASSWORD`, …), never through command-line arguments, and you name the snapshot with `--label`.
* **Role names.** Owners and grants are left out of `schema.sql`, and `pg_stat_statements` user IDs are aggregated away.
* **Credentials inside the schema.** Foreign servers, user mappings and subscriptions (connection strings, passwords) are removed from `schema.sql`.
* **Free text.** `COMMENT ON` and security labels are removed from `schema.sql`. SQL comments are removed from statement text.
* **Literals in statement text.** See the next section.
* **Partial-index predicates.** `shape.json` records only that an index is partial; the predicate is in `schema.sql`.

### How statement text is handled

`pg_stat_statements` replaces constants with `$1`, `$2`, … But its documentation says constants can survive "especially when there is a high rate of entry deallocations". Some never get replaced at all: a positional `GROUP BY 1` keeps its number, and utility commands such as `COMMENT ON … IS '…'` keep their text verbatim. So QueryGuard treats statement text as hostile:

1. Text that Postgres hides from the role (`<insufficient privilege>`) is dropped, and the snapshot is PARTIAL.
2. Text that cannot be read with confidence (an unterminated string or comment) is replaced with `[redacted: unparseable]`.
3. Utility commands (anything but `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`) are dropped.
4. Comments are removed.
5. If any string or numeric literal remains, the whole text is replaced with `[redacted: literal]`. The counters are kept, and so are the names of the snapshot's own tables, which are already in `schema.sql`. This check is strict: a type length such as `varchar(10)` also triggers it.

Every queryid whose text was replaced is listed in `redactions.json`.

### How it is enforced

* **A strict schema.** [`schema/snapshot.v1.json`](../schema/snapshot.v1.json) rejects any field it does not define, so a value column cannot appear in a valid snapshot even through a future bug. Its one map, the removed-object counts in `redactions.json`, accepts any object type name but only an integer count. QueryGuard validates its own output before writing anything, and validates again on every load.
* **Integrity.** Every file's SHA-256 is in `manifest.json`. A file edited after the snapshot was taken, an unlisted file, or a missing file makes the snapshot invalid. The Action then reports the run as INCONCLUSIVE instead of using it.
* **Tests on PostgreSQL 14, 15, 16, 17 and 18** (`npm test`), described next.

## The canary test

[`test/snapshot-canary.test.ts`](../test/snapshot-canary.test.ts) builds a fixture database on every supported major version and plants unique strings ("canaries") wherever a careless exporter could pick them up:

* in emails and names (they end up in `histogram_bounds`);
* in a low-cardinality status column and a JSONB field (they end up in `most_common_vals`);
* in a column comment;
* in literals in executed `SELECT` and `UPDATE` statements;
* in inline `/* … */` and trailing `-- …` comments on executed statements.

It then ANALYZEs, runs a workload, takes a snapshot in the default mode, and asserts that **no canary, and no database name, role name, password or host, appears in any file of the artifact**, or in `snapshot inspect`'s report.

Two controls keep the test honest:
* A **positive control** checks, as a superuser, that each canary really is visible in `pg_stats` or `pg_stat_statements`, so the test cannot pass because the fixture is broken.
* A **negative control** checks that the scanner finds a planted leak.

The full-mode test runs the same scan. There, the allow-listed column's canary must appear in `stats.sql` and every other canary must not.

Other tests:
* **Statement capture:** every statement the collectors send is recorded. The tests require that only catalog and statistics views are read, that no value column is selected in shape mode, and that no function that locks a table is called.
* **Lock safety:** collection completes while another session holds `ACCESS EXCLUSIVE` on the fixture tables.

## Safety on production

* **Read-only.**
  * Every session sets `default_transaction_read_only`.
  * Collection runs in short `REPEATABLE READ READ ONLY` transactions.
  * pg_dump runs with `default_transaction_read_only=on`.
  * `--sample-window` takes two readings without holding a transaction open between them, so it does not hold back vacuum.
* **Bounded.**
  * `lock_timeout` 1 s, `statement_timeout` 10 s, `idle_in_transaction_session_timeout` 30 s.
  * The session is named `queryguard-snapshot` in `pg_stat_activity`, so a DBA can find and stop it.
* **No locks on your tables from the collectors.**
  * They read catalogs and statistics views only, and compute sizes from page counts.
  * `pg_relation_size`, `pg_get_indexdef` and `pg_get_expr` would each take a lock on the table and wait behind a migration, so they are never called.
* **pg_dump is the one step that takes table locks** (`ACCESS SHARE`, the same lock a plain `SELECT` takes). Its wait is capped at 5 seconds. If it times out, the run fails, nothing is written, and the previous snapshot stays as it was. With `--schema-from`, pg_dump runs elsewhere (next section).
* **Never run:** `ANALYZE`, `VACUUM`, any statistics reset, any query on your tables.

## Required grants

Postgres facts that decide the grants:
* `pg_read_all_stats` lets a role read every `pg_stat_*` view and every role's `pg_stat_statements` text.
* `pg_stats` only shows columns the role may `SELECT`, which `pg_read_all_stats` does not grant.
* pg_dump needs `SELECT` on every table it dumps, to lock it.

### Option A: a role that cannot read any row (recommended)

As an administrator (a superuser, or the master user on a managed service):

```sql
CREATE ROLE queryguard_snapshot LOGIN PASSWORD '…' CONNECTION LIMIT 2;
GRANT pg_read_all_stats TO queryguard_snapshot;
GRANT CONNECT ON DATABASE app TO queryguard_snapshot;
GRANT USAGE ON SCHEMA public TO queryguard_snapshot;  -- the schema pg_stat_statements is installed in
ALTER ROLE queryguard_snapshot SET default_transaction_read_only = on;
ALTER ROLE queryguard_snapshot SET statement_timeout = '10s';
ALTER ROLE queryguard_snapshot SET lock_timeout = '1s';
-- pg_stat_statements must be in shared_preload_libraries (needs a restart), and created in this database:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Then, **as the role that owns the application's tables**, create the shape function. It returns the skew profile from `pg_stats`, never the values:

```sql
CREATE SCHEMA IF NOT EXISTS queryguard;
CREATE FUNCTION queryguard.column_shape()
  RETURNS TABLE (schemaname name, tablename name, attname name, inherited bool,
                 null_frac real, avg_width int, n_distinct real, correlation real,
                 most_common_freqs real[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT schemaname, tablename, attname, inherited, null_frac, avg_width,
           n_distinct, correlation, most_common_freqs
    FROM pg_catalog.pg_stats
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema') $$;
REVOKE ALL ON FUNCTION queryguard.column_shape() FROM PUBLIC;
GRANT USAGE ON SCHEMA queryguard TO queryguard_snapshot;
GRANT EXECUTE ON FUNCTION queryguard.column_shape() TO queryguard_snapshot;
```

* **Make the schema dump where owner credentials already exist,** for example in the deploy job right after migrations: `pg_dump --schema-only > schema.sql`. Then run `queryguard snapshot --schema-from schema.sql`.
* **What the file goes through:** QueryGuard applies the same checks and scrubbing as to its own dump. It rejects a file containing any data, or dumped from a different major version, and reports a file whose tables no longer match the catalog.
* **What the tests show:** a role set up this way produces a COMPLETE snapshot and is refused `SELECT` on the tables.

### Option B: one role, simpler

Option A without the function, plus `GRANT pg_read_all_data TO queryguard_snapshot` (PostgreSQL 14+). QueryGuard runs pg_dump itself.

The role *can* read every row. QueryGuard does not; the statement-capture test shows what it sends. But a reviewer should know the grant allows it.

### Full mode: column grants for exactly the allow-list

`GRANT SELECT (status) ON public.orders TO queryguard_snapshot;` for each allow-listed column. The grant is the server-side mirror of the allow-list. An allow-listed column the role cannot read makes the snapshot PARTIAL rather than silently empty.

### Amazon RDS and Aurora PostgreSQL

* **The administrator** is the master user (a member of `rds_superuser`); there is no superuser.
* **pg_stat_statements** is in the default `shared_preload_libraries` of RDS for PostgreSQL 11+ and of Aurora PostgreSQL's default cluster parameter group, per AWS documentation. A custom parameter group must keep it, and `CREATE EXTENSION` is still needed per database.
* **Encryption:** connect with `PGSSLMODE=verify-full` and the RDS certificate bundle.
* **Not yet verified on a live RDS or Aurora instance:**
  * that `rds_superuser` can `GRANT pg_read_all_stats` and `pg_read_all_data`;
  * that the shape function behaves the same when owned by the application owner role.

  Check both once in a staging instance before relying on them, and tell us what you find.

## Full mode

`--mode full --allow-columns <file>` (PostgreSQL 18 servers) additionally writes `stats.sql`. That file contains `pg_restore_relation_stats` and `pg_restore_attribute_stats` calls that reproduce production's planner statistics in another database.

* **Allow-listed columns** get every statistic, *including values*: their most common values and histograms leave production.
* **Every other column** gets shape fields only.
* **The allow-list:** one column per line, e.g. `public.orders.status`. An entry that matches nothing fails the run, and `manifest.json` lists the resolved columns.
* **Choose them as you would choose what to show in a dashboard:** low-cardinality, non-personal columns such as status codes are typical. Never emails, names or free text.

## How to review a snapshot refresh

Start with `npx queryguard snapshot inspect .queryguard/snapshot`.
* It verifies every file's SHA-256 and the schema, then prints the label, age, mode, status, largest tables, busiest statements and the full redaction report.
* An invalid snapshot exits `1` and prints its problems. Do not merge it.

Then read the diff:

1. **`manifest.json`.** Is `mode` what you expect? In full mode, is every column in `allowed_columns` one you approve? Is `precision` `approx`? If `status` is `PARTIAL`, are the `partial_reasons` acceptable?
2. **`redactions.json`.** Large changes in `excluded.text_hidden` mean the role lost `pg_read_all_stats`. Every queryid under `redacted` had its text replaced. That is expected, not a leak.
3. **`workload.json`.** Read the new or changed `text` values. They should be SQL with `$n` placeholders and nothing that looks like data.
4. **`schema.sql`.** Read new definitions in full. **Function and view bodies, column defaults, `CHECK` constraints and enum labels are copied verbatim**, and a function body can contain anything a developer wrote into it, including a secret.
5. **`stats.sql`** (full mode). `grep -c most_common_vals stats.sql` should not exceed the number of allow-listed columns. It can be up to twice that for an inheritance parent, which has one statistics row with its child tables and one without.
6. **`shape.json`.** Counts are rounded. Diffs here are expected growth.

## What a snapshot does reveal

Even in the default mode, a snapshot is not empty of information:
* every table, column, index, view and function name, and their definitions;
* approximate table sizes and traffic;
* query structure;
* each column's skew profile, for example that one value accounts for 80% of a column.

Treat the directory with the same care as the schema, which most teams already keep in the repository.
