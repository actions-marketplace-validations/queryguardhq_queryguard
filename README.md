# 🛡️ QueryGuard

[![Marketplace](https://img.shields.io/badge/Marketplace-QueryGuard%20Sentinel-blue?logo=github)](https://github.com/marketplace/actions/queryguard-sentinel)
[![npm version](https://img.shields.io/npm/v/@queryguardhq/queryguard.svg)](https://www.npmjs.com/package/@queryguardhq/queryguard)
[![npm provenance](https://img.shields.io/badge/provenance-attested-brightgreen)](https://www.npmjs.com/package/@queryguardhq/queryguard)
[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)
[![Live Sandbox](https://img.shields.io/badge/Web%20App-Live%20Sandbox-blueviolet)](https://query-guard.netlify.app/)

**QueryGuard** is a PostgreSQL **migration lock linter** plus a **synthetic query-plan smoke test**. It is a CI check, not a guarantee of production safety. This is what it does today:

1. **Migration lock linter.** Statically flags a short list of migration patterns that take blocking locks or fail at deploy time (see [What it checks](#what-it-checks)). It needs no database.
2. **Migration dry run.** In CI it builds your baseline schema in an ephemeral Postgres, applies your migration, and reports the first statement that fails.
3. **Synthetic query-plan smoke test.** It fills the tables with generated rows and runs `EXPLAIN` on your `queries.sql`. Sequential scans are reported as *informational* hints only. They never fail the build, and a clean result is **not** evidence that your queries are fast on production data.

👉 **Interactive Hub & Configurator:** [https://query-guard.netlify.app/](https://query-guard.netlify.app/)

---

## Where it runs

| Layer | Trigger | Mechanism | Infrastructure |
| :--- | :--- | :--- | :--- |
| **1. Static linter** | Git pre-commit / local CLI | SQL tokenizer and pattern rules | None (no database) |
| **2. AI agent guard** | Agent task completion | The same linter, invoked via instructions in `AGENTS.md` | None (no database) |
| **3. CI PR check** | Pull request open / sync | Ephemeral Postgres 16, schema + migration + `EXPLAIN` | GitHub Actions runner with a Postgres service |
| **4. Production snapshot** (optional) | A scheduled refresh, reviewed as a pull request | Read-only export of production's shape, committed to the repo; the PR check reads it | A job that can reach production (bastion or self-hosted runner) |

---

## What it checks

The linter has three rules. A run that reports no findings means *these three rules found nothing*; it does not mean the migration is safe.

| Rule | Why it matters | Reported as |
| :--- | :--- | :--- |
| `CREATE INDEX` without `CONCURRENTLY` | Takes a `SHARE` lock that blocks writes while the index builds. | `SHARE` lock |
| `ALTER TABLE … ALTER COLUMN … TYPE` | Can rewrite the table under an `ACCESS EXCLUSIVE` lock. | `ACCESS EXCLUSIVE` lock |
| `CREATE INDEX CONCURRENTLY` inside a transaction | Postgres rejects it, so the migration fails at deploy. | `CONCURRENTLY` in a transaction |

Everything else is out of scope today, for example `ADD COLUMN … NOT NULL`, adding foreign keys or constraints without `NOT VALID`, `DROP`, `RENAME`, and `REINDEX`. The `ALTER COLUMN TYPE` rule is deliberately conservative: it also flags type changes that Postgres can do without a rewrite (for example widening a `varchar`).

Every finding comes with remediation SQL built from your own statement, for example the same `CREATE INDEX` with `CONCURRENTLY` inserted. Fixes are tested to pass the linter and to execute on Postgres 16.

---

## 1. Local pre-commit linter (no database)

```bash
# View CLI options and help
npx queryguard --help

# Static lock validation
npx queryguard --lint --migration path/to/migration.sql
```

| Exit code | Meaning |
| :--- | :--- |
| `0` | None of the rules above matched. |
| `1` | A hazard was found (remediation SQL is printed), or the file was not found. |

If your migration runner wraps each file in a transaction, add `--assume-in-transaction` so `CREATE INDEX CONCURRENTLY` is flagged (see [Transactions](#transactions-and-concurrently)).

### Enforce via a git pre-commit hook

Add this to `.husky/pre-commit` or `.git/hooks/pre-commit`:

```bash
git diff --cached --name-only --diff-filter=ACM | grep -E "\.sql$" | while read -r file; do
  npx queryguard --lint --migration "$file" || exit 1
done
```

---

## 2. AI coding agent protocol (`AGENTS.md`)

AI coding agents routinely write non-concurrent indexes and in-place column rewrites. Add an `AGENTS.md` to your repository root so they run the linter and self-correct. This is advisory: it steers the agent, it does not enforce anything.

`CONCURRENTLY` advice must depend on how your migrations run, because `CREATE INDEX CONCURRENTLY` fails inside a transaction and Rails and Django wrap migrations in one by default. This template says so:

```markdown
# Database Safety Guidelines for AI Coding Agents

When authoring or modifying database schemas, migrations, or database queries:

1. **Migration Lock Rules:**
   - Do not create an index on an existing table with a plain `CREATE INDEX`; it takes a `SHARE` lock and blocks writes.
   - Use `CREATE INDEX CONCURRENTLY` **only if the migration does not run inside a transaction.**
     `CONCURRENTLY` fails inside a transaction block, and many runners wrap every migration in one
     (Rails and Django do by default), as does an explicit `BEGIN ... COMMIT` in the file.
     - Not in a transaction: use `CREATE INDEX CONCURRENTLY`.
     - In a transaction: do not just add `CONCURRENTLY`. Opt the migration out first
       (Rails: `disable_ddl_transaction!`; Django: `atomic = False`), or put the index in its own
       migration that runs outside a transaction.
   - Never run `ALTER COLUMN ... TYPE ...` in place; stage the change through a new nullable column to avoid an `ACCESS EXCLUSIVE` lock.

2. **Pre-Completion Validation:**
   - Before completing tasks that modify migrations, run:
     `npx queryguard --lint --migration <path-to-file>`
     (add `--assume-in-transaction` if your runner wraps each file in a transaction)
   - If the command exits with code 1, read the hazard and its suggested fix, apply it, and re-run
     until it exits with code 0. For a `[TRANSACTION]` hazard, move the statement out of the
     transaction; do not remove `CONCURRENTLY`.
```

---

## 3. Pre-merge PR check (GitHub Actions)

Add `.github/workflows/queryguard.yml`:

```yaml
name: QueryGuard

on:
  pull_request:

permissions:
  pull-requests: write
  contents: read

jobs:
  queryguard:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Run QueryGuard
        uses: queryguardhq/queryguard@v1
        with:
          schema-path: 'db/schema.sql'
          migration-path: 'db/migrations/latest.sql'
          queries-path: 'db/queries.sql'
          fail-on-sev1: 'false'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The baseline schema should be a **schema-only** dump (`pg_dump --schema-only`); the file is split into statements and run one by one, so `COPY … FROM stdin` data blocks are not supported.

### Statuses and exit codes

Every run ends in one of three statuses, shown first in the PR comment and in the job summary:

| Status | Meaning |
| :--- | :--- |
| **PASS** | Every check ran, and the rules found nothing. |
| **FAIL** | A migration statement failed to apply (the report gives the statement, its line number and the Postgres error), **or** a lock or transaction hazard was found. |
| **INCONCLUSIVE** | Something could not be checked, so the result is *not* a pass. The report lists exactly what was skipped and why. |

A run is never reported as PASS if anything was skipped. FAIL takes precedence over INCONCLUSIVE.

What produces INCONCLUSIVE:

* The baseline schema could not be built (a statement errored, or `schema-path` is missing). The run stops there.
* `migration-path` was given but the file is missing.
* Synthetic rows could not be generated for a table (see [Known limitations](#known-limitations)). That table is skipped.
* `EXPLAIN` failed for a statement in `queries.sql`. That query is skipped.

A migration statement that fails to apply stops the run and is a **FAIL**.

| Mode | Exit code |
| :--- | :--- |
| **Strict** (`fail-on-sev1: 'true'`) | `0` PASS, `1` FAIL, `2` INCONCLUSIVE |
| **Advisory** (default, `fail-on-sev1: 'false'`) | Always `0`. The job passes, and the PR comment and job summary still lead with the status. |

In both modes, an unrecoverable error (for example, Postgres is unreachable or `queries-path` cannot be read) exits `1`.

`fail-on-sev1` is a legacy name kept for backward compatibility; it means "strict mode".

### Sequential scans are informational

The query section runs `EXPLAIN` on generated rows (`mock-rows` per table, 2,000 by default), not on your data. A sequential scan there is reported under *Informational: sequential scan on synthetic data*, with an optional index suggestion. It **never** affects the status, the exit code or `fail-on-sev1`. Only migration findings can fail strict mode. A clean query section is not evidence of production safety: synthetic data cannot reproduce production row counts, skew or statistics.

### Transactions and `CONCURRENTLY`

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. QueryGuard flags it when it appears between an explicit `BEGIN`/`START TRANSACTION` and `COMMIT` in the same file.

If your runner wraps each migration file in a transaction (Rails and Django do by default), set `assume-in-transaction: 'true'` (CLI: `--assume-in-transaction`). QueryGuard then treats the whole file as transactional, flags `CONCURRENTLY`, and runs the migration inside `BEGIN`/`COMMIT` so you see the real Postgres error. To use `CONCURRENTLY` anyway, opt the migration out of the transaction:

* **Rails:** call `disable_ddl_transaction!` in the migration class.
* **Django:** set `atomic = False` on the `Migration` class.
* **Other runners:** keep the index in its own migration that runs outside a transaction.

---

## Production snapshots

A lock finding says *what* a migration locks. A snapshot adds *how much that matters on your production database*. The finding's row in the PR comment gains a column like this:

| Severity | Issue Type | Target Table | Production (snapshot) |
| :--- | :--- | :--- | :--- |
| 🚨 CRITICAL | `SHARE` Lock | `orders` | ~48M rows · ~14 GB · 3 query shapes · ~2,100 calls/s |

The snapshot is a directory, `.queryguard/snapshot/`, committed to your repository:
* production's schema (`pg_dump --schema-only`, scrubbed);
* table and index sizes and activity counters;
* each column's statistical shape (never its values);
* the busiest normalized statements from `pg_stat_statements`.

**The PR check never receives production credentials.** It only reads the committed directory. A separate job with production access refreshes the snapshot and proposes each refresh as a pull request, so every change to it is reviewed.

**1. Create a read-only role for the snapshot.** [docs/snapshot-security.md](docs/snapshot-security.md#required-grants) has the grants, including a setup in which the role cannot read a single row.

**2. Take a snapshot** wherever production is reachable. The connection comes from the standard libpq environment, never from arguments:

```bash
PGHOST=db.internal PGDATABASE=app PGUSER=queryguard_snapshot npx queryguard snapshot --label production
```

| Option | Meaning |
| :--- | :--- |
| `--label` | A name for the snapshot (required). Nothing in the snapshot comes from connection details. |
| `--sample-window 5m` | Read `pg_stat_statements` twice, 5 minutes apart, so call rates reflect current traffic rather than an average since the last reset. |
| `--top N` | Keep the top N statements by total time, plus the top N by calls (default 200). |
| `--precision exact` | Do not round. By default every count, size and time is rounded to 2 significant figures. |
| `--schema-from FILE` | Use a `pg_dump --schema-only` file made elsewhere, so the snapshot role needs no table access. |
| `--mode full --allow-columns FILE` | PostgreSQL 18: also write `stats.sql`, the full planner statistics, with values only for the columns you list. |

| Exit code | Meaning |
| :--- | :--- |
| `0` | COMPLETE. |
| `2` | PARTIAL: written, but something could not be collected; `manifest.json` says what. |
| `1` | Failed: nothing written, and any previous snapshot is untouched. |

**3. Review and commit it.** `npx queryguard snapshot inspect` validates the snapshot (every file's SHA-256 and the [JSON Schema](schema/snapshot.v1.json)) and prints what is in it, including the full redaction report. The [security guide](docs/snapshot-security.md#how-to-review-a-snapshot-refresh) has a review checklist.

**4. Point the PR check at it:**

```yaml
      - name: Run QueryGuard
        uses: queryguardhq/queryguard@v1
        with:
          schema-path: 'db/schema.sql'
          migration-path: 'db/migrations/latest.sql'
          snapshot-path: '.queryguard/snapshot'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

What the PR check does with it:
* An invalid snapshot makes the run **INCONCLUSIVE**.
* A snapshot older than `snapshot-max-age-days` (14 by default) gets a warning at the top of the report, and so does a PARTIAL one.
* Severities and exit codes do not change.

**5. Refresh it on a schedule.** [docs/examples/snapshot-refresh.yml](docs/examples/snapshot-refresh.yml) is a weekly workflow for a self-hosted runner that can reach production, and [docs/examples/snapshot-refresh.sh](docs/examples/snapshot-refresh.sh) does the same from a bastion's cron. Each opens a pull request with the refreshed snapshot.

**What leaves production, and what never does.** [docs/snapshot-security.md](docs/snapshot-security.md) is written for your security reviewer. In short:
* No row values in the default mode, and no host, user, password or database name.
* Statement text keeps only `$n` placeholders: any text with a surviving literal is replaced.
* A test plants unique strings in emails, names, statuses, JSON, comments and query literals on PostgreSQL 14 through 18, and fails if any reaches the snapshot.
* Snapshots support PostgreSQL 14 and newer.

---

## ⚙️ Action configuration parameters

| Input parameter | Description | Default | Required |
| :--- | :--- | :--- | :--- |
| `schema-path` | Path to the baseline schema DDL (a `pg_dump --schema-only` file). Applied without lock checks. | `''` | No |
| `migration-path` | Path to the incoming migration DDL. Checked by the lock rules, then applied. | `''` | No |
| `queries-path` | Path to a SQL file of queries to `EXPLAIN` against synthetic data. | `'test/queries.sql'` | Yes |
| `fail-on-sev1` | Strict mode: exit `1` on FAIL and `2` on INCONCLUSIVE. Sequential scans never fail the job. In advisory mode (`false`) the job always passes. | `'false'` | No |
| `assume-in-transaction` | Set to `'true'` if your runner wraps each migration file in a transaction. See [Transactions](#transactions-and-concurrently). | `'false'` | No |
| `mock-rows` | Synthetic rows generated per table for the query-plan smoke test. | `'2000'` | No |
| `snapshot-path` | A `queryguard snapshot` directory committed to the repo (see [Production snapshots](#production-snapshots)). Lock findings are annotated with production row counts, sizes and traffic; severities do not change. An invalid snapshot makes the run INCONCLUSIVE. | `''` | No |
| `snapshot-max-age-days` | A snapshot older than this many days gets a stale warning at the top of the report. | `'14'` | No |
| `github-token` | GitHub token for posting and updating the PR comment in place. | `''` | No |
| `pg-host` | PostgreSQL host. | `'localhost'` | No |
| `pg-port` | PostgreSQL port. | `'5432'` | No |
| `pg-user` | PostgreSQL user. | `'postgres'` | No |
| `pg-password` | PostgreSQL password. | `'postgres'` | No |
| `pg-database` | PostgreSQL database name. | `'postgres'` | No |

---

## Known limitations

* **Three rules only.** See [What it checks](#what-it-checks). No findings does not mean a migration is safe.
* **Synthetic data is simple.** It generates rows for integer, text, numeric, UUID, JSON, timestamp and boolean columns. It cannot populate custom or enum types with `NOT NULL`, or generated columns. An `int` primary key or unique column with no default also fails, because the generator reuses small values. These tables are **skipped and reported**, making the run INCONCLUSIVE. Only tables in the `public` schema are populated.
* **Needs a privileged Postgres role.** Generating rows sets `session_replication_role = 'replica'` to bypass foreign keys, which requires superuser (the default `postgres` user in the service container is). With a role that cannot do this, the run exits `1`.
* **Runner requirements.** The Action runs on the Node 24 action runtime. GitHub-hosted runners are fine; self-hosted runners must be v2.327.1 or newer.
* **Hand-written parsing.** Statements are split and recognized by a small tokenizer and pattern rules, not Postgres's own parser, so unusual syntax can be missed.
* **Table-level view.** Plans come from planner estimates on generated data, with no production statistics, indexes or concurrency.
* **Snapshots annotate, they do not judge.** Production context is shown next to lock findings but changes no severity. Statements that reach a table only through a view are not counted for that table. Unqualified table names that exist in several schemas are reported as ambiguous rather than guessed.

---

## 🔒 Data privacy

* **Runs on your compute:** inside your existing GitHub Actions runner or on your machine.
* **No third-party services:** the PR check makes no network calls except to the GitHub API, to post the PR comment when you pass `github-token`, and `queryguard snapshot` connects only to the database you point it at. Note that the comment and job summary contain your migration and query statements and table names, so they are as visible as the pull request.
* **Synthetic rows only in CI:** the PR check never reads your data. Rows are generated into an ephemeral database.
* **Snapshots carry shape, not data:** see [Production snapshots](#production-snapshots) and [docs/snapshot-security.md](docs/snapshot-security.md).

---

## 📄 License

QueryGuard is open-source software licensed under the [MIT License](LICENSE).

---

*Built with Claude Code*
