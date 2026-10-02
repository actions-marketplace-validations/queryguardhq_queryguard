# Design: `queryguard snapshot` (Phase 1)

**Status:** accepted 2026-10-02. The draft's open questions are settled under [Decisions](#decisions-2026-10-02).
**Goal:** export the *shape* of a production database into a reviewable, committed artifact, so the PR Action can say what a migration touches on *your* production (approximate rows, size, traffic) without the PR workflow ever holding production credentials.

Phase 1 does not change severities, add plan analysis or load statistics into the CI database. Those are later phases.

## Summary of decisions

1. **The snapshot never takes a lock on a user table.** It reads catalogs and cumulative-stats views only, in one short `READ ONLY` transaction with `lock_timeout` and `statement_timeout` set. It computes sizes from `relpages × block_size`, **not** from `pg_relation_size`/`pg_total_relation_size`, because those take `AccessShareLock` on the table, its TOAST table and every index (verified in source, see [V4](#v4-do-the-size-functions-lock-the-relation)). For the same reason it never deparses (`pg_get_indexdef`, `pg_get_expr`); index expression text comes from `schema.sql`.
2. **`pg_dump --schema-only` is the one step that does lock user tables.** It takes `ACCESS SHARE` on every table it dumps, which needs `SELECT` on each table. We run it with `--lock-wait-timeout` and fail the whole run if it times out (see [pg_dump](#schemasql-and-pg_dump)).
3. **Reading `pg_stats` needs per-column `SELECT`.** `pg_read_all_stats` does **not** grant it (verified in the docs, the view source and a live test, see [V1](#v1-who-can-see-rows-in-pg_stats-and-what-pg_read_all_stats-grants)). Together with (2), this means a plain snapshot role can read row data, even though QueryGuard never queries user tables. The grants recipe offers a `SECURITY DEFINER` shape function so `pg_stats` itself needs no table grants, and `--schema-from` removes the pg_dump grant too ([Decision 1](#decisions-2026-10-02)).
4. **Query text is treated as hostile.** pg_stat_statements keeps comments inside the statement, and the docs say constants can survive normalization (see [V3](#v3-does-pg_stat_statements-query-text-keep-comments)). We strip comments, then **redact the whole text** whenever the tokenizer finds anything that looks like a literal or something it does not understand. A redacted query still contributes its counters.
5. **Fail closed.** One relation that fails marks the snapshot `PARTIAL` with a reason. A run that cannot produce `schema.sql` writes nothing, and the old snapshot stays intact. The write is atomic (temporary directory, then rename).

## Verified facts

Checked on 2026-10-02 against the PostgreSQL docs for 14–18, the `REL_14_STABLE` and `REL_18_STABLE` source, and a live `postgres:18-alpine` container.

### V1. Who can see rows in `pg_stats`, and what `pg_read_all_stats` grants

* **Docs:** `pg_stats` "allows access only to rows of `pg_statistic` that correspond to tables the user has permission to read" ([18 §53.29](https://www.postgresql.org/docs/18/view-pg-stats.html); same text in [14 §52.89](https://www.postgresql.org/docs/14/view-pg-stats.html)).
* **Source:** the filter is per **column**, not per table, and RLS hides rows too. `system_views.sql` (14 and 18): `WHERE NOT attisdropped AND has_column_privilege(c.oid, a.attnum, 'select') AND (c.relrowsecurity = false OR NOT row_security_active(c.oid))`.
* **`pg_read_all_stats`** "allows reading all `pg_stat_*` views and use various statistics related extensions, even those normally visible only to superusers" ([18 §21.5](https://www.postgresql.org/docs/18/predefined-roles.html); [14 §22.5](https://www.postgresql.org/docs/14/predefined-roles.html)). `pg_stats` is not a `pg_stat_*` view, and the role grants no `SELECT`. `pg_monitor` includes `pg_read_all_stats`, `pg_read_all_settings` and `pg_stat_scan_tables`, so it does not help either.
* **Live test (PG18):** a role with only `pg_read_all_stats` saw **0** `pg_stats` rows for an analyzed table. After `GRANT SELECT (status) ON people`, it saw exactly the `status` row.
* **Consequences:**
  * Column-level `SELECT` is the minimal grant to read `pg_stats` directly, and `pg_read_all_data` is the broad one ([§21.5](https://www.postgresql.org/docs/18/predefined-roles.html); it "does not bypass row-level security"). Either way, the role *could* read rows.
  * Under RLS, `pg_stats` hides a table's rows unless the role has `BYPASSRLS` or the table owner disables RLS. We record that case as PARTIAL, `stats_hidden_by_rls`.
  * We can tell "no privilege" apart from "never analyzed" with `has_column_privilege()`. The first is PARTIAL; the second is recorded as `stats: null` with `analyzed: false` and is not PARTIAL.
* **Alternative that needs no table grants:** a `SECURITY DEFINER` function owned by a role that can read the tables (the schema owner), returning only the shape fields. See the [recipe](#minimal-grants-recipe).

### V2. pg_stat_statements columns and `pg_stat_statements_info`, PG 14–18

Diffed from the column tables of each version's docs ([14 F.30](https://www.postgresql.org/docs/14/pgstatstatements.html), [15 F.32](https://www.postgresql.org/docs/15/pgstatstatements.html), [16 F.32](https://www.postgresql.org/docs/16/pgstatstatements.html), [17 F.30](https://www.postgresql.org/docs/17/pgstatstatements.html), [18 F.32](https://www.postgresql.org/docs/18/pgstatstatements.html)):

| Change | Columns |
| :--- | :--- |
| Present in all of 14–18 | `userid dbid toplevel queryid query plans total_plan_time … calls total_exec_time min/max/mean/stddev_exec_time rows shared_blks_hit/read/dirtied/written local_blks_* temp_blks_read/written wal_records wal_fpi wal_bytes` |
| 15 adds | `temp_blk_read_time temp_blk_write_time jit_*` (8 columns) |
| 16 | no column changes |
| 17 **renames** | `blk_read_time`/`blk_write_time` → `shared_blk_read_time`/`shared_blk_write_time`; adds `local_blk_read_time local_blk_write_time jit_deform_count jit_deform_time stats_since minmax_stats_since` |
| 18 adds | `wal_buffers_full parallel_workers_to_launch parallel_workers_launched` |

* **What we read:** only columns present in every version 14–18: `toplevel, queryid, dbid, query, calls, total_exec_time, mean_exec_time, rows, shared_blks_hit, shared_blks_read`. So we need no per-version SQL for the workload. `userid` is used only to aggregate across roles and is never exported.
* **`pg_stat_statements_info`** exists in 14–18 with the same two columns, `dealloc bigint` and `stats_reset timestamptz` (§F.x.2 of each page). We record both. A non-zero `dealloc` is shown in the redaction report, because deallocation is exactly when the docs say constants can survive (V3).
* **Visibility:** "only superusers and roles with privileges of the `pg_read_all_stats` role are allowed to see the SQL text and queryid of queries executed by other users" (18 §F.32.1; 14 says "members of"). Without that role we would see `<insufficient privilege>`. We treat that as PARTIAL, `workload_text_hidden`, and never as an empty workload.
* **MERGE** is a plannable statement from 15 on (the 14 doc lists only `SELECT, INSERT, UPDATE, DELETE`).

### V3. Does pg_stat_statements query text keep comments?

* **Docs:** the constant is replaced by `$n`, and "the rest of the query text is that of the first query that had the particular queryid hash value" (18 §F.32.1; identical in 14 §F.30.1). The docs do not mention comments explicitly. They also warn that queries "may be observed with constant values in pg_stat_statements, especially when there is a high rate of entry deallocations" (16–18), and that constant replacement applies only "when `compute_query_id` is enabled".
* **PG18 adds comments of its own:** a squashed `IN` list is displayed as `IN ($1 /*, ... */)` (18 §F.32.1).
* **Live test (PG18, through psql):** `SELECT … IN (1,…,7) -- CANARY_COMMENT_2` was stored as `SELECT id FROM people WHERE id IN ($1 /*, ... */) -- CANARY_COMMENT_2`. **Comments inside or after the statement are kept.** A leading `/* CANARY_COMMENT_1 */` was not stored, presumably because the text starts at the statement's parse location. psql also handles comments on the client, so item 1 re-checked this through the `pg` driver. **Confirmed on 14, 15, 16, 17 and 18:** the canary fixture's positive control finds both an inline `/* … */` comment and a trailing `-- …` comment in `pg_stat_statements.query`.
* **Consequence:** we strip every comment (line and nested block) before anything else, and we also drop any query text containing the sentinel `<insufficient privilege>`.

### V4. Do the size functions lock the relation?

* **Docs:** silent. The size functions table ([18 §9.28.7, Table 9.102](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE)) does not mention locking.
* **Source (`src/backend/utils/adt/dbsize.c`, `REL_14_STABLE` and `REL_18_STABLE`):** `pg_relation_size`, `pg_table_size`, `pg_indexes_size` and `pg_total_relation_size` all call `try_relation_open(relOid, AccessShareLock)`. The table and total variants also `relation_open(…, AccessShareLock)` the TOAST table, its index and every index.
* **Why it matters:** `ACCESS SHARE` "conflicts with the ACCESS EXCLUSIVE lock mode only" ([18 §13.3.1](https://www.postgresql.org/docs/18/explicit-locking.html)). But a lock request queues behind a waiting `ACCESS EXCLUSIVE`, for example a migration's `ALTER TABLE`. A snapshot calling `pg_total_relation_size` at that moment would wait, or with `lock_timeout` fail on exactly the tables we care most about.
* **Deparsing locks too (found by the item 2 lock test, then probed on 14, 16 and 18):** with another session holding `ACCESS EXCLUSIVE` on a table, these all waited until `lock_timeout`:
  * `pg_get_indexdef(index, k, true)`, even for a plain column key;
  * `pg_get_expr(pg_index.indexprs, indrelid)`.

  These returned at once:
  * `pg_class`, `pg_attribute` and `pg_stats` reads;
  * `row_security_active()` and `has_column_privilege()`;
  * `pg_stat_user_tables`/`pg_stat_user_indexes`;
  * `format_type()` and `pg_get_constraintdef()`.

  So the collectors call no deparse function on a user relation. A test lists the forbidden calls, and another test holds `ACCESS EXCLUSIVE` on fixture tables while collecting.
* **Decision:** sizes are `relpages × current_setting('block_size')`, summed over the heap, its TOAST relation and the TOAST index, and each index (`pg_class.relpages` of each). `relpages` is an estimate maintained by VACUUM, ANALYZE and CREATE INDEX, so we label sizes "estimated from relpages" and record `last_analyze`/`last_autoanalyze`.

### V5. PG18 `pg_restore_relation_stats` / `pg_restore_attribute_stats`, and pg_dump 18 against older servers

* **Signatures** ([18 §9.28.7, Table 9.105](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-STATSMOD)): both are `( VARIADIC kwargs "any" ) → boolean`, taking `'argname', value::type` pairs.
  * Relation: required `schemaname`, `relname`; stats `relpages integer`, `reltuples real`, `relallvisible integer`, `relallfrozen integer`; optional `version integer`.
  * Attribute: required `schemaname`, `relname`, either `attname text` or `attnum smallint`, and `inherited`; other arguments are "names and values of statistics corresponding to columns in `pg_stats`"; optional `version integer`.
  * Both require `MAINTAIN` on the table or ownership of the database.
  * "Minor errors are reported as a WARNING and ignored … If all specified statistics are successfully restored, returns true, otherwise false." So **the item 5 test must assert every call returned `true`**, not just that `stats.sql` ran without error.
  * The section warns that such changes "are likely to be overwritten by autovacuum".
* **pg_dump 18 from older servers:** the docs say pg_dump "can also dump from PostgreSQL servers older than its own version (Currently, servers back to version 9.2 are supported.)" but "cannot dump from PostgreSQL servers newer than its own major version" ([pg_dump 18, Notes](https://www.postgresql.org/docs/18/app-pgdump.html)). The docs do not specifically say statistics work cross-version. **The source confirms they do** (`src/bin/pg_dump/pg_dump.c`, `REL_18_STABLE`):
  * Attribute stats are read from `pg_catalog.pg_stats`, with `NULL AS range_*` when `remoteVersion < 170000`.
  * Each call carries `'version', '<remoteVersion>'::integer`.
  * `relallfrozen` is emitted only when `remoteVersion >= 180000`.
  * A pre-14 `reltuples = 0` is rewritten to `-1`.
* **Other pg_dump 18 facts we rely on** (same page):
  * `--schema-only` dumps "only the object definitions (schema), not data or statistics".
  * `--no-statistics` "is the default".
  * `--lock-wait-timeout` fails "if unable to lock a table within the specified timeout". The source implements it with `SET statement_timeout` around the `LOCK TABLE` batches.
  * Plain-text output contains a random `\restrict` key unless `--restrict-key` is given, and the docs advise against fixing the key outside testing.
* **Phase 1 implication:** item 5 limits full mode to PG18 servers as specified, but nothing in Postgres requires that. The same `pg_stats` → `pg_restore_*` path works from 14+ servers into a PG18 target, so we could relax it later.

### V6. `pg_stats` columns across versions

From each version's column table (links in V1, plus [15](https://www.postgresql.org/docs/15/view-pg-stats.html), [16](https://www.postgresql.org/docs/16/view-pg-stats.html), [17](https://www.postgresql.org/docs/17/view-pg-stats.html)):

| Versions | Columns |
| :--- | :--- |
| 14–18 | `schemaname tablename attname inherited null_frac avg_width n_distinct most_common_vals most_common_freqs histogram_bounds correlation most_common_elems most_common_elem_freqs elem_count_histogram` |
| 17–18 add | `range_length_histogram range_empty_frac range_bounds_histogram` |

Shape mode reads only `inherited null_frac avg_width n_distinct correlation most_common_freqs`, which exist in every version. Full mode (PG18 only) adds the rest.

**Related:** `pg_stat_all_tables` has **no per-table `stats_reset`** column in 14 or 18 ([18 §27.2](https://www.postgresql.org/docs/18/monitoring-stats.html)). Table counters reset with the database, so we record `pg_stat_database.stats_reset` for the current database. `pg_stat_reset_single_table_counters()` can reset one table without leaving a timestamp, which the docs for consumers must mention.

## CLI surface

```
queryguard snapshot --label <name> [--out .queryguard/snapshot] [--mode shape|full]
                    [--allow-columns <file>]           # required with --mode full
                    [--top <N=200>] [--sample-window <duration>]
                    [--precision approx|exact]         # default approx
                    [--pg-dump <path>]                 # default: first compatible pg_dump on PATH
                    [--schema-from <file>]             # use a schema-only dump made elsewhere (Decision 1)
                    [--lock-timeout 1s] [--statement-timeout 10s] [--lock-wait-timeout 5s]
queryguard snapshot inspect <dir>
```

* **Connection:** only from the standard libpq environment (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`/`.pgpass`, `PGDATABASE`, `PGSSLMODE`, and so on), passed unchanged to `pg_dump`. There is no connection flag, so no secret appears in shell history or `ps`.
* **Required inputs:** `--label` (`[A-Za-z0-9._-]{1,64}`), so nothing in the artifact is derived from connection details.
* **Session setup:**
  * `application_name = 'queryguard-snapshot'`, so a DBA can see and kill it.
  * `default_transaction_read_only = on`, `lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`.
  * `stats_fetch_consistency = snapshot` on 15+, so all cumulative-stats reads within a transaction agree.
  * One `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` per reading.
  * A `SAVEPOINT` per relation batch: a failed batch is rolled back, recorded as PARTIAL, and the run continues.
* **`--sample-window 5m`:**
  * Takes reading 1 in its own short transaction and **closes it**, waits, then takes reading 2. Holding a snapshot open for the whole window would pin the xmin horizon and hold back vacuum on production, so we never do that.
  * Deltas are computed per `queryid`. An entry missing from either reading is reported in `workload.sampling.unmatched`, as is any change in `dealloc` between the readings.
* **Exit codes:** `0` COMPLETE, `2` PARTIAL (artifact written), `1` failure (nothing written). This mirrors PASS/INCONCLUSIVE.
* **Never run:** `ANALYZE`, `VACUUM`, anything against a user table, or `pg_stat_*_reset`. A test asserts this by capturing every statement we send.

## Artifact layout

```
.queryguard/snapshot/
  manifest.json     format_version, created_at, label, server_version_num, mode, precision,
                    status: COMPLETE | PARTIAL, partial_reasons[], tool_version,
                    files: { name: sha256 }  (integrity, checked on load)
  schema.sql        pg_dump --schema-only (see below)
  shape.json        relations, indexes, columns, stats_reset times
  workload.json     selected statements with counters and referenced relations
  redactions.json   what was withheld and why (counts and queryids, never content)
  stats.sql         full mode only
```

### `shape.json` (abridged)

```json
{
  "block_size": 8192,
  "size_source": "relpages",
  "column_stats_source": "pg_stats",
  "stats_reset": { "database": "2026-09-01T00:00:00Z" },
  "relations": [
    { "schema": "public", "name": "orders", "kind": "table", "partition_of": null,
      "reltuples": 48000000, "relpages": 1200000, "relallvisible": 1100000,
      "size_bytes": { "table": 9800000000, "indexes": 4100000000, "total": 14000000000 },
      "activity": { "n_live_tup": 48000000, "n_dead_tup": 120000, "seq_scan": 12, "idx_scan": 980000000,
                    "n_tup_ins": 3100000, "n_tup_upd": 2200000, "n_tup_del": 0 },
      "last_analyze": "2026-10-01T03:12:00Z",
      "columns": [
        { "name": "status", "attnum": 4,
          "stats": [ { "inherited": false, "null_frac": 0, "avg_width": 7, "n_distinct": 5,
                       "correlation": 0.0412, "mcv_freqs": [0.8123, 0.1201, 0.0402, 0.0201, 0.0073] } ] },
        { "name": "email", "attnum": 2, "stats": [], "missing": "no_privilege" }
      ] }
  ],
  "indexes": [
    { "schema": "public", "name": "orders_customer_id_idx", "table_schema": "public", "table_name": "orders",
      "kind": "index", "method": "btree", "unique": false, "primary": false, "valid": true, "partial": false,
      "keys": [ { "column": "customer_id" } ], "include": [],
      "size_bytes": 1100000000, "idx_scan": 410000000 },
    { "schema": "public", "name": "orders_lower_ref_idx", "...": "...",
      "keys": [ { "expression": "lower(ref)" } ] }
  ]
}
```

* **Relation kinds:** `table, partitioned_table, matview, foreign_table`; index kinds `index, partitioned_index`.
  * A partition names its parent in `partition_of`.
  * TOAST size is folded into its table.
  * Excluded: system schemas (`pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp_*`), temporary relations, and relations that belong to an extension (pg_dump leaves those out of `schema.sql` too).
* **Column statistics:** `stats` holds one entry per `inherited` value present: a partitioned table has only the `inherited: true` row, and an inheritance parent can have both. An empty `stats` comes with `missing`:
  * `no_privilege` (PARTIAL)
  * `hidden_by_rls` (PARTIAL)
  * `no_stats`: never analyzed, or statistics target 0. Not PARTIAL; it is a fact about the server.
* **Index keys** come from `pg_index.indkey` joined to `pg_attribute`, which takes no lock.
  * **Expression text is filled in from `schema.sql`.** Deparsing it on the server with `pg_get_indexdef` or `pg_get_expr(…, relid)` takes `AccessShareLock` on the table (V4), so the collector records `{ "expression": null }` and the writer completes it from the dump.
  * The predicate is recorded as a boolean only, because a partial-index predicate can contain literals. The full definition is in `schema.sql`.
* **`n_live_tup` and `n_dead_tup` are estimates.** For example, on 14–16 an ANALYZE in the same session as a bulk insert can count those rows twice. `reltuples` is the planner's figure and the one the Action reports.

### `workload.json` (abridged)

```json
{
  "source": { "extension_version": "1.11", "stats_reset": "…", "dealloc": 0,
              "window": { "kind": "since_reset" } },
  "selection": { "top_by_total_time": 200, "top_by_calls": 200, "selected": 287 },
  "statements": [
    { "queryid": "-4235817762918331217", "kind": "SELECT",
      "text": "SELECT id FROM orders WHERE customer_id = $1",
      "calls": 7100000000, "total_exec_ms": 81000000, "mean_exec_ms": 0.0114, "rows": 7100000000,
      "relations": ["public.orders"], "unresolved": [] },
    { "queryid": "…", "kind": "UPDATE", "text": "[redacted: literal]", "calls": 1, "relations": [], "unresolved": [] }
  ]
}
```

* `window.kind` is `since_reset` or `sampled` (with `seconds`). Rates are computed at load time from the window, so the artifact stores counts, not rates.
* Statements are aggregated across `userid` per `queryid` in the current `dbid`, `toplevel = true` only.
* `relations` lists only names that resolve against `shape.json`. A statement redacted for a literal keeps its resolved relations; its unresolved names are counted, not listed. A statement redacted as `unparseable` has no relations ([Decision 3](#decisions-2026-10-02)).

## Privacy rules (shape mode)

**Collected:** catalog structure; per-relation counts and sizes; per-column `null_frac`, `avg_width`, `n_distinct`, `correlation`, and `most_common_freqs` (frequencies only, as a skew profile); index metadata; normalized, comment-stripped statement text that passed the literal detector; aggregate counters.

**Never collected in shape mode:** `most_common_vals`, `histogram_bounds`, `most_common_elems`, `most_common_elem_freqs`, `elem_count_histogram`, `range_*`. These columns are **not even selected** in shape mode, so they never reach QueryGuard's memory. We also never collect host, port, user, database name, role names, `userid`/`dbid`, or partial-index predicates.

**Statement text pipeline**, in order. Any step that is unsure redacts.

1. Drop the entry if the text is `<insufficient privilege>` (PARTIAL).
2. Strip comments with a scanner that handles nested `/* */`, `--`, and quotes and dollar quotes. Unterminated constructs → redact (`reason: unparseable`).
3. Classify by the first keyword: `SELECT/INSERT/UPDATE/DELETE/MERGE`, or `WITH` followed by one of those (`TABLE` and `VALUES` count as SELECT). Anything else is excluded (`reason: not_dml`).
4. **Literal detector** on the tokens: any string-like token (`'…'`, `E'…'`, `U&'…'`, `B'…'`, `X'…'`, dollar-quoted) or any numeric token that is not part of a `$n` parameter → `[redacted: literal]`. This deliberately catches false positives like a typmod `varchar(10)`, and the redaction report counts them.
5. Store the stripped, normalized text.

**`schema.sql`** contains everything DDL contains: table, column and index names, enum labels, defaults, check constraints, view and function bodies. Function bodies can embed anything, including secrets. `schema.sql` is the file a reviewer must actually read (see [pg_dump](#schemasql-and-pg_dump)).

**Rounding:** with `--precision approx` (the default), every row, page, byte and counter value is rounded to 2 significant figures. Fractions (`null_frac`, `correlation`, `mcv_freqs`) are fixed at 4 decimal places. `n_distinct` is rounded to 2 significant figures if positive and kept to 4 decimals if negative (it is then a ratio).

## `schema.sql` and pg_dump

* **Version check:** we locate `pg_dump` (`--pg-dump` or `PATH`), run `pg_dump --version`, and require major ≥ server major. If none qualifies, we fail with the exact install instruction for the server's major version. There is no fallback.
* **Flags:** `--schema-only --no-owner --no-privileges --no-publications --no-subscriptions --no-security-labels --no-tablespaces --no-comments --lock-wait-timeout=<ms>`, with `PGOPTIONS='-c default_transaction_read_only=on'`.
  * `--no-subscriptions` keeps `CONNECTION` strings out.
  * Role names leave through owners and grants, so we drop those too.
  * `--no-comments` is always passed ([Decision 4](#decisions-2026-10-02)).
* **Post-processing:**
  * Remove the `\restrict`/`\unrestrict` lines, so a refresh diff is stable and the dump's random key is not committed.
  * Remove `CREATE SERVER … OPTIONS`, `CREATE USER MAPPING` and `-- Dumped from/by` header lines. Each removal is counted in `redactions.json`.
  * Then normalize line endings.
  * Reject anything that is not schema-only (`COPY`, `INSERT`, `pg_restore_*_stats`), and check the tables against the catalog. The same checks apply to a `--schema-from` file ([Decision 1](#decisions-2026-10-02)).
* **Locks:** pg_dump issues `LOCK TABLE … IN ACCESS SHARE MODE` for every table whose definition it dumps, even in schema-only mode (`DUMP_COMPONENTS_REQUIRING_LOCK` includes `DUMP_COMPONENT_DEFINITION` in `pg_dump.h`). [`LOCK`](https://www.postgresql.org/docs/18/sql-lock.html) in ACCESS SHARE mode needs `SELECT` on the table (or a stronger privilege). This is the one part of the run that can wait on a user-table lock, so `--lock-wait-timeout` is mandatory. A timeout fails the whole run, and the previous snapshot is kept.

## Full mode (`--mode full`, PG18 only)

* `--allow-columns <file>`: one `schema.table.column` per line, `#` comments allowed. Unknown entries fail the run, so a typo can never silently allow nothing or the wrong thing.
* Allow-listed columns: we read all `pg_stats` fields for them, which needs `SELECT` on exactly those columns. The column grant is the server-side mirror of the allow-list.
* Every other column gets shape-only fields in `stats.sql` (`null_frac`, `avg_width`, `n_distinct`, `correlation`), without `most_common_freqs`, because frequencies without values are meaningless to the planner.
* `stats.sql` is generated by us: one `pg_restore_relation_stats` per relation and one `pg_restore_attribute_stats` per column, with `'version', <server_version_num>`, wrapped so that a `false` result raises.

## Action consumption (item 7, summary)

* **Inputs:** `snapshot-path` (default `''`, which means off) and `snapshot-max-age-days` (default `14`).
* **Load:** check that the manifest hashes match the files, then validate against `schema/snapshot.v1.json`. Any failure adds a skipped item (`stage: 'snapshot'`), so the run is INCONCLUSIVE.
* **Stale snapshot:** a warning line above everything else in the report.
* **PARTIAL snapshot:** a warning plus "no data" on affected tables, never INCONCLUSIVE ([Decision 5](#decisions-2026-10-02)).
* **Annotation:** each lock finding's `targetTable` is resolved by name parts. An unqualified name is tried as `public.<name>`; when the name exists in several schemas it is labelled ambiguous and not guessed. Example: `orders: ~48M rows · ~14 GB · 14 query shapes · ~2,100 calls/s (avg since 2026-09-01)`.
* **Status and severity logic:** unchanged.
* **Dependencies and network:** no network use. The snapshot is read from the checkout. JSON Schema validation uses `ajv`, pinned and bundled by `ncc` ([Decision 6](#decisions-2026-10-02)).

## Test plan highlights

* **Matrix:** Postgres 14–18. GitHub service containers cannot pass `-c shared_preload_libraries=…`, so `docker-compose.test.yml` gains one service per version (ports 5414–5418, `pg_stat_statements` preloaded), and CI starts it with the same `npm run test:db:up` as a developer. The existing suite keeps running on 16.
* **pg_dump in tests:** the real pg_dump 18 inside the PG18 test container, through a shim on `PATH`, or `QG_TEST_PG_DUMP`; fail loudly if neither works ([Decision 7](#decisions-2026-10-02)). pg_dump 18 dumps every server version in the matrix.
* **Canaries:**
  * Values are alphanumeric tokens such as `QGC4n4ry7f3a…`, so JSON escaping cannot disguise them. They are placed in emails, names, a low-cardinality status (so it lands in MCVs), a JSONB field, literals in executed queries, and inline and trailing comments on executed queries. The workload is generated through the `pg` driver.
  * **Positive control:** as superuser, assert the canaries really are in `pg_stats.most_common_vals`/`histogram_bounds` and in `pg_stat_statements.query` comments, so the test is not passing vacuously.
  * **Negative control:** the scanner must flag a deliberately leaky artifact directory.
  * Item 1 can't run real collectors yet. To keep the suite green, it adds a `snapshot` command that writes only `manifest.json`, and items 2–5 grow it.
* **Lock safety:**
  * A second session holds `ACCESS EXCLUSIVE` on a fixture table. Shape and workload collection must still complete.
  * pg_dump must time out within `--lock-wait-timeout`, and the run must exit `1` with the previous artifact unchanged.
  * Every statement QueryGuard sends is captured and checked against an allow-list of catalog and stat views.
* **Surviving literals:** we can't reliably make Postgres store a non-normalized constant in a DML statement. Forcing deallocation with a tiny `pg_stat_statements.max` would make the shared test servers flaky. So the guarantee comes from unit tests of the detector over literal-bearing texts, and the integration canary test asserts absence either way.
* **A comment canary** goes on a column (`COMMENT ON COLUMN`), enforcing [Decision 4](#decisions-2026-10-02).

## Minimal-grants recipe

**Option A: a dedicated role with no data-read grants for the collectors.** Recommended.

```sql
-- As an administrator (superuser, or rds_superuser on RDS/Aurora):
CREATE ROLE queryguard_snapshot LOGIN PASSWORD '…' CONNECTION LIMIT 2;
GRANT pg_read_all_stats TO queryguard_snapshot;            -- pg_stat_* views and pg_stat_statements text
GRANT CONNECT ON DATABASE app TO queryguard_snapshot;
GRANT USAGE ON SCHEMA public TO queryguard_snapshot;       -- per application schema
ALTER ROLE queryguard_snapshot SET default_transaction_read_only = on;
ALTER ROLE queryguard_snapshot SET statement_timeout = '10s';
ALTER ROLE queryguard_snapshot SET lock_timeout = '1s';
ALTER ROLE queryguard_snapshot SET idle_in_transaction_session_timeout = '30s';

-- pg_stat_statements must be preloaded (server restart) and created in this database:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Shape without SELECT on tables: run as the role that owns the application tables.
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

* The function exposes only shape columns. It sees whatever its owner can see, and it does not bypass RLS unless the owner does.
* When `queryguard.column_shape()` exists, QueryGuard uses it and does not read `pg_stats` directly.
* **pg_dump is the gap, and `--schema-from` closes it:** pg_dump needs `SELECT` on every table (V5 / `LOCK`). So with Option A, produce the schema-only dump where table-owner credentials already exist, for example in the deploy job right after migrations. Then run `queryguard snapshot --schema-from schema.sql` as `queryguard_snapshot`. That role can read statistics but not one row.

**Option B: one role, simpler.** Option A without the function, plus `GRANT pg_read_all_data TO queryguard_snapshot` (PG14+). The role can technically read every row. QueryGuard does not, and the statement-capture test proves which statements it sends, but a reviewer should know the grant allows it.

**Full mode:** add `GRANT SELECT (col, …) ON schema.table TO queryguard_snapshot` for exactly the allow-listed columns.

**RDS / Aurora PostgreSQL:**

* There is no superuser. The administrator is the master user, a member of `rds_superuser`, and runs the statements above.
* pg_stat_statements is in the default `shared_preload_libraries` of RDS for PostgreSQL 11+ ([AWS docs](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.UsingDashboard.AnalyzeDBLoad.AdditionalMetrics.PostgreSQL.html)). A custom parameter group must keep it there, and `CREATE EXTENSION` is still needed per database.
* Aurora's default cluster parameter group also preloads it ([AWS docs](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.UsingDashboard.AnalyzeDBLoad.AdditionalMetrics.PostgreSQL.html)).
* **Not yet verified on a live RDS instance, so item 8 must confirm before we document it as fact:**
  * that `rds_superuser` can `GRANT pg_read_all_stats` and `pg_read_all_data`;
  * that the `SECURITY DEFINER` function works when owned by the application owner role;
  * that Aurora's `aurora_stat_statements` is not needed.
* Connect with `PGSSLMODE=verify-full` and the RDS CA bundle.

## Decisions (2026-10-02)

The draft ended with open questions. These are the answers, chosen for what QueryGuard has to be: something a security reviewer can approve without trusting us.

1. **pg_dump privilege: add `--schema-from <file>`.** By default `queryguard snapshot` runs pg_dump itself, as specified, and that path needs `SELECT` on every table (Option B in the recipe).
   * `--schema-from` takes a `pg_dump --schema-only` file produced elsewhere, for example by the deploy pipeline that already holds owner credentials, or by a DBA.
   * With the shape function, this gives a snapshot role that **cannot read a single row**. That is the strongest privacy claim we can make, and it costs one flag.
   * The file goes through exactly the same scrubbing and checks as our own pg_dump output:
     * Reject anything that is not schema-only: any `COPY … FROM stdin`, `INSERT INTO`, or `pg_restore_*_stats` call fails the run.
     * Its `-- Dumped from database version` major must equal the server's.
     * Its tables must match the catalog (next bullet).
   * `manifest.json` records `schema_source: "pg_dump" | "file"`.
   * **Consistency check, both paths:** the set of tables, partitioned tables and materialized views created in `schema.sql` must equal the set in `shape.json`. A mismatch (DDL raced the snapshot, or a stale `--schema-from` file) marks the snapshot PARTIAL and names the missing relations.
2. **pg_dump failure is fatal.** No artifact is written and the previous snapshot stays as it was. `schema.sql` is what every later phase builds on. An artifact without it would pass validation and still be useless, which is the quiet failure Phase 0 removed.
3. **No libpg_query in Phase 1. The snapshot gets its own small lexer** (`src/snapshot/lexer.ts`), built for the privacy path: nested block comments, `E''`/`U&''`/`B''`/`X''` strings, dollar quotes, `$n` parameters, and an `unsure` signal on anything unterminated.
   * Phase 0's tokenizer has known bugs (spike, "Fidelity"), and privacy-critical code should be small enough for a reviewer to read in one sitting.
   * We do not touch `src/ddl.ts`, because the lock rules are out of scope.
   * Relation extraction sits behind `extractRelations(text) → { relations, unresolved }`, so the AST can replace it once the spike's shadow mode has run.
   * **Redacted statements keep table attribution:** for a statement redacted for a literal, we still extract relations, but emit **only names that resolve to a relation already in `shape.json`**. Their traffic still counts toward the table, and nothing new leaves production. Unresolved names from such a statement are counted, never listed. Statements redacted as `unparseable` get no extraction.
4. **Comments are always excluded** (`--no-comments`), with no flag. Phase 1 has no use for `COMMENT ON` text, and free text is where secrets end up. A canary in a column comment enforces this. We can add an opt-in later if a later phase needs comments.
5. **A PARTIAL snapshot is a warning in the Action, not INCONCLUSIVE.** The warning sits at the top of the report and lists the partial reasons; affected findings say "no snapshot data (reason)". Annotations are informational in Phase 1 and never change status. An **invalid** snapshot (schema or hash failure) is still INCONCLUSIVE, as specified, because then nothing in it can be trusted.
6. **`ajv` (draft 2020-12), pinned to an exact version, bundled by `ncc`.**
   * Validating against the exact published `schema/snapshot.v1.json` means there is one source of truth: a third party validating with any 2020-12 validator gets our answer.
   * No `ajv-formats`: timestamps use a `pattern`.
   * No remote `$ref` loading, so no network.
   * A hand-written validator would drift from the published schema.
7. **Tests use the real pg_dump 18 from the PG18 test container,** through a small shim that the harness puts first on `PATH`.
   * The product's `PATH` lookup and version check are therefore exercised for real, and the suite needs nothing but Docker, locally and in CI (this machine has no host pg_dump).
   * `QG_TEST_PG_DUMP=/path/to/pg_dump` uses a host binary instead.
   * If neither works, the snapshot tests fail loudly, like `assertPostgres16`.
   * The product itself does not change: it still needs a compatible pg_dump on `PATH` and fails with instructions when there isn't one.
8. **Rounding covers every measurement.** Under `--precision approx`, every count, size, page count, counter, `calls` and execution time is rounded to 2 significant figures. Fractions keep 4 decimal places. Identifiers and configuration (`attnum`, `block_size`, `server_version_num`) are exact. One rule is easier to audit than a list, and call volume is as business-sensitive as row counts.
9. **The README test stays.** The RDS/Aurora notes live in `docs/snapshot-security.md`, and the README links there.
