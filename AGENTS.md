# Database Safety Guidelines for AI Coding Agents

When authoring or modifying database schemas, migrations, or database queries in this repository:

## 1. Migration Lock Rules
- **Indexes:** Never generate CREATE INDEX on existing tables without CONCURRENTLY.
  - Incorrect: CREATE INDEX idx_users_email ON users(email); (acquires SHARE lock, blocking table writes).
  - Correct: CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
- **Column Rewrites:** Never alter a column type in place via ALTER TABLE ... ALTER COLUMN ... TYPE ... (acquires ACCESS EXCLUSIVE lock, blocking all reads and writes). Stage transitions using a new nullable column.

## 2. Pre-Completion Validation Step
Before marking any task complete that creates or modifies a migration file:
1. Run the static lock linter:
   node dist/index.js --lint --migration path/to/migration.sql

2. **Self-Correction Rule:**
   - If the linter exits with code 1, inspect the reported [SHARE] or [ACCESS EXCLUSIVE] hazard.
   - Apply the recommended remediation syntax (e.g., adding CONCURRENTLY).
   - Re-run the command until it exits with code 0.
