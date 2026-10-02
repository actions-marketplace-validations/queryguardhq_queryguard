# Database Safety Guidelines for AI Coding Agents

When authoring or modifying database schemas, migrations, or database queries in this repository:

## 1. Migration Lock Rules
- **Indexes:** Never generate a plain CREATE INDEX on an existing table (acquires a SHARE lock, blocking table writes).
  - Use CREATE INDEX CONCURRENTLY **only if the migration does not run inside a transaction.** CONCURRENTLY fails inside a transaction block, and many runners wrap every migration in one (Rails and Django do by default), as does an explicit BEGIN ... COMMIT in the file.
  - Incorrect: CREATE INDEX idx_users_email ON users(email);
  - Correct, migration NOT in a transaction: CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
  - Migration IS in a transaction: do not just add CONCURRENTLY. Opt the migration out first (Rails: `disable_ddl_transaction!`; Django: `atomic = False`), or put the index in its own migration that runs outside a transaction.
- **Column Rewrites:** Never alter a column type in place via ALTER TABLE ... ALTER COLUMN ... TYPE ... (acquires ACCESS EXCLUSIVE lock, blocking all reads and writes). Stage transitions using a new nullable column.

## 2. Pre-Completion Validation Step
Before marking any task complete that creates or modifies a migration file:
1. Run the static lock linter:
   node dist/index.js --lint --migration path/to/migration.sql
   (add --assume-in-transaction if the migration runner wraps each file in a transaction)

2. **Self-Correction Rule:**
   - If the linter exits with code 1, inspect the reported [SHARE], [ACCESS EXCLUSIVE] or [TRANSACTION] hazard.
   - Apply the recommended remediation syntax (e.g., adding CONCURRENTLY when not in a transaction). For a [TRANSACTION] hazard, move the statement out of the transaction; do not remove CONCURRENTLY.
   - Re-run the command until it exits with code 0.
