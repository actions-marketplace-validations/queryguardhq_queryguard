# QueryGuard

QueryGuard is an automated CI/CD blast-radius sentinel for PostgreSQL that detects full table scans and blocking migration locks (`ACCESS EXCLUSIVE` and `SHARE`) prior to merging.

## Features

- **Sequential Scan Detection:** Evaluates execution plans against mocked production catalog distributions.
- **Migration Lock Sentinel:** Flags non-concurrent index creations and blocking table rewrites.
- **Automated DDL Remediation:** Generates copy-pasteable `CREATE INDEX CONCURRENTLY` statements directly inside PR comments.
- **In-Place Comment Updating:** Keeps PR discussion threads clean by updating reports in place.
- **CI Gating (`fail-on-sev1`):** Blocks unindexed regressions from reaching production databases.

## Usage

Add the following workflow to `.github/workflows/queryguard.yml` in any target repository:

```yaml
name: QueryGuard Blast-Radius Sentinel

on:
  pull_request:

permissions:
  pull-requests: write
  issues: write
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

      - name: Run QueryGuard
        uses: munir-pathak/queryguard@v1
        with:
          schema-path: 'test/schema.sql'
          queries-path: 'test/queries.sql'
          pg-host: 'localhost'
          pg-port: '5432'
          pg-user: 'postgres'
          pg-password: 'postgres'
          pg-database: 'testdb'
          fail-on-sev1: 'true'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `schema-path` | **Yes** | `test/schema.sql` | Path to SQL schema DDL or migration file |
| `queries-path` | **Yes** | `test/queries.sql` | Path to SQL queries file to benchmark |
| `fail-on-sev1` | No | `'false'` | Fail CI step on critical scan or lock detection |
| `github-token` | No | `''` | GitHub token required for PR commenting |
| `pg-host` | No | `'localhost'` | PostgreSQL host |
| `pg-port` | No | `'5432'` | PostgreSQL port |
| `pg-user` | No | `'postgres'` | PostgreSQL user |
| `pg-password` | No | `'postgres'` | PostgreSQL password |
| `pg-database` | No | `'postgres'` | PostgreSQL database name |
| `mock-rows` | No | `'500000'` | Simulated cardinality scale factor |
