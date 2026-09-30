# 🛡️️ QueryGuard

[![GitHub release](https://img.shields.io/github/v/release/queryguardhq/queryguard?color=blue)](https://github.com/queryguardhq/queryguard/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Live Sandbox](https://img.shields.io/badge/Web%20App-Live%20Sandbox-blueviolet)](https://query-guard.netlify.app/)

**QueryGuard** is an automated PostgreSQL blast-radius sentinel and migration lock linter. It prevents table-locking database migrations (`ACCESS EXCLUSIVE` and `SHARE` locks) and unindexed full table scans from reaching production AWS RDS and Aurora instances.

It operates upstream across three layers:
1. **Pre-Commit Static Linter:** Runs locally in `< 20ms` with zero database or container dependencies.
2. **AI Coding Agent Sentinel:** Directs tools like Claude Code, Cursor, and Devin via `AGENTS.md` to self-correct non-concurrent DDL before staging.
3. **Pre-Merge CI Sentinel:** Executes against an ephemeral PostgreSQL container inside GitHub Actions, scaffolding type-aware synthetic data to evaluate query planner costs and updating PR comments in place.

👉 **Interactive Hub & Configurator:** [https://query-guard.netlify.app/](https://query-guard.netlify.app/)

---

## ⚡ Three-Tier Architecture

| Layer | Trigger Point | Execution Mechanism | Latency | Infrastructure Required |
| :--- | :--- | :--- | :--- | :--- |
| **1. Static Linter** | Git Pre-Commit / Local CLI | AST & regex parsing via token stream | `< 20ms` | Zero (No DB, No Docker) |
| **2. AI Agent Guard** | Agent Task Completion | Terminal command invoked via `AGENTS.md` | `< 20ms` | Zero (No DB, No Docker) |
| **3. CI PR Gate** | Pull Request Open / Sync | Ephemeral Postgres 16 container + `EXPLAIN` | `~8s` | GitHub Actions Runner |

---

## 1. Local Pre-Commit Linter (Zero DB)

Evaluate migration files on developer workstations before pushing code:

```bash
# View CLI options and help
npx queryguard --help

# Ad-hoc static lock validation
npx queryguard --lint --migration path/to/migration.sql
```

* **Exit Code `0`:** Clean. All indexes use `CONCURRENTLY` and column types are not altered in place.
* **Exit Code `1`:** Hazard detected. Emits copy-pasteable remediation SQL.

### Enforce via Git Pre-Commit Hook

Add this check to `.husky/pre-commit` or `.git/hooks/pre-commit` to prevent dangerous DDL from being committed:

```bash
git diff --cached --name-only --diff-filter=ACM | grep -E "\.sql$" | while read -r file; do
  npx queryguard --lint --migration "$file" || exit 1
done
```

---

## 2. AI Coding Agent Protocol (`AGENTS.md`)

AI coding agents routinely generate non-concurrent indexes and blocking table rewrites. Add an `AGENTS.md` file to your repository root to enforce self-correction:

```markdown
# Database Safety Guidelines for AI Coding Agents

When authoring or modifying database schemas, migrations, or database queries:

1. **Migration Lock Rules:**
   - Always use `CREATE INDEX CONCURRENTLY` on existing tables. Never acquire a `SHARE` lock.
   - Never run `ALTER COLUMN ... TYPE ...` in place; stage transitions using a new nullable column to avoid `ACCESS EXCLUSIVE` locks.

2. **Pre-Completion Validation:**
   - Before completing tasks modifying migrations, run:
     `npx queryguard --lint --migration <path-to-file>`
   - If the command exits with code 1, apply the suggested fix and re-run until it exits with code 0.
```

---

## 3. Pre-Merge PR Sentinel (GitHub Actions)

Add `.github/workflows/queryguard.yml` to evaluate incoming pull requests.

```yaml
name: QueryGuard Blast-Radius Sentinel

on:
  pull_request:

permissions:
  pull-requests: write
  contents: read

jobs:
  blast-radius-check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: testdb
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

      - name: Run QueryGuard Sentinel
        uses: queryguardhq/queryguard@v1
        with:
          schema-path: 'db/schema.sql'
          migration-path: 'db/migrations/latest.sql'
          queries-path: 'db/queries.sql'
          fail-on-sev1: 'false'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

---

## ⚙️ Action Configuration Parameters

| Input Parameter | Description | Default | Required |
| :--- | :--- | :--- | :--- |
| `schema-path` | Path to baseline schema DDL (e.g., `pg_dump --schema-only`). Applied without lock checks. | `''` | No |
| `migration-path` | Path to incoming PR migration DDL. Analyzed for `ACCESS EXCLUSIVE` and `SHARE` locks. | `''` | No |
| `queries-path` | Path to SQL queries file evaluated for sequential scans against synthetic data. | `'test/queries.sql'` | Yes |
| `fail-on-sev1` | Hard-fail CI (exit code 1) if a critical sequential scan or lock hazard is detected. | `'false'` | No |
| `mock-rows` | Synthetic row count generated per table for catalog cost simulation. | `'2000'` | No |
| `github-token` | GitHub token for posting and editing in-place PR comment reports. | `''` | No |
| `pg-host` | PostgreSQL container host. | `'localhost'` | No |
| `pg-port` | PostgreSQL container port. | `'5432'` | No |
| `pg-user` | PostgreSQL username. | `'postgres'` | No |
| `pg-password` | PostgreSQL password. | `'postgres'` | No |
| `pg-database` | PostgreSQL database name. | `'postgres'` | No |

---

## 🔒 Zero-PII Data Privacy Guarantee

* **100% Ephemeral Customer Compute:** Runs inside your existing GitHub Actions runner or local machine.
* **No Outbound Data Ingestion:** Zero queries, schema definitions, table names, or customer data leave your infrastructure.
* **Synthetic Scaffolding:** Generates mock records dynamically across modern PostgreSQL types (`UUID`, `JSONB`, `NUMERIC`, `TIMESTAMP`) and disables foreign keys via `session_replication_role = 'replica'`.

---

## 📄 License

QueryGuard is open-source software licensed under the [MIT License](LICENSE).
