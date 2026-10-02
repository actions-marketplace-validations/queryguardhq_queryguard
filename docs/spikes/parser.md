# Spike: replace the hand-rolled SQL parsing with libpg_query, and ingest Squawk

**Status:** spike only. Nothing here is merged, and no source file in `src/` was changed. The prototype code lived in a scratch directory; the parts worth keeping are in the [appendix](#appendix-prototype-code).
**Question:** should the hand-rolled splitter (`src/splitter.ts`), tokenizer (`src/ddl.ts`) and pattern rules (`src/locks.ts`) be replaced by libpg_query bindings, given that the Action ships as one bundled `dist/index.js`? And what would a `--squawk-json <file>` input look like?

## Recommendation

1. **Yes, adopt libpg_query, but incrementally and with the existing tokenizer kept as the fallback.** Use **`libpg-query@16.x`** (WASM, Postgres 16 grammar). Do not use a native addon, and do not use a multi-version package. Land it in three steps (see [rollout](#rollout)), starting with a *shadow mode* that runs both implementations and reports differences, so we learn from real-world migrations before changing any verdict.
2. **Do not promise "a single `dist/index.js`".** The WASM is not inlined by `ncc`. The honest packaging is `dist/index.js` plus one `dist/libpg-query.wasm` (962 KB), which the Action and the npm package both ship from `dist/`. Embedding the WASM into the JS is possible in principle but I did not find a supported way (see [open questions](#open-questions)).
3. **Add `--squawk-json` as an ingest-only input, informational by default, with an opt-in list of gating rules.** It buys breadth (Squawk has many more rules) without us writing and maintaining them, which fits QueryGuard's niche: the real-Postgres dry run and fail-closed statuses.

The strongest argument is not performance. It is that **our hand-rolled splitter has real bugs** that a real parser doesn't (below), and every new rule we write by regex or token matching will inherit them.

## What was evaluated

All checked on 2026-10-01 against the npm registry. "Grammar" is the Postgres major version the parser understands.

| Package | Version | Delivery | Grammar | WASM size | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`libpg-query`** | **16.7.3** | WASM, no install script | **PG 16** | 962 KB | `loadModule`, `parse`, `parseSync` only. Errors carry a byte `cursorPosition`. **Recommended.** |
| `libpg-query` | 18.1.5 | WASM | PG 18 | 1.7 MB | Adds `scanSync` (lexer), fingerprint, normalize. |
| `@libpg-query/parser` | 17.6.10 | WASM | PG 17 | 2.1 MB | Same family as above. |
| `@supabase/pg-parser` | 0.1.7 | WASM, ESM | PG 15/16/17 | 1.5-1.8 MB each | Has `parse`, `scan`, `deparse`. Under `ncc` it produced ESM with 5 split chunks and 3 `.wasm` files (about 6.5 MB), and the bundle failed to start in my run (a `createRequire` shim error). I did not debug it. |
| `@pgsql/parser` | 1.5.0 | WASM, multi-version | PG 13-18 | 0.9-1.2 MB per version | Parsed correctly when bundled, but also logged a `LinkError`: every version's glue loads a file named `libpg-query.wasm`, so the names collide in one `dist/`. Fragile under a bundler. |
| `pg-query-emscripten` | 5.1.0 | WASM | PG 13 | 4.6 MB | Last published 2024-09. Not pursued. |
| `pgsql-deparser` | 18.3.8 | pure JS | n/a (a PG18-line release) | 1.1 MB unpacked | Turns an AST back into SQL. Separate from the parser. I used it on PG16 ASTs and it worked for every construct I tried, but the version mismatch is untested beyond that. |

No native addon was needed, and none of the WASM candidates has an install script, so there is no `node-gyp` or per-platform binary problem. I did not evaluate native `libpg_query` bindings further, since WASM works.

## Measured results

Environment: macOS, Node 23 for timing; the bundled prototype was also run on **Node 20** (the Action's runtime) in `node:20-slim` and returned the expected findings.

### Fidelity: our rules vs the same rules on the AST

I ported the three rules to the AST and ran both implementations over the same 18 inputs: 14 modeled on the cases in our own tests, plus 4 chosen to stress a hand-rolled splitter. **15 are identical, 3 differ. All 3 differences are bugs in the hand-rolled version.**

| Input | Hand-rolled (today) | AST |
| :--- | :--- | :--- |
| `SELECT E'a\'b;c'; CREATE INDEX i ON t(c);` | **Misses the index.** It does not understand `\'` inside an `E'…'` string, so it splits the statement at the `;` inside the string. | Flags `i`. |
| `/* outer /* inner */ CREATE INDEX hidden ON t(c); */ CREATE INDEX shown ON t(d);` | **Flags `hidden`, a statement that is inside a comment, and mis-splits.** Postgres block comments nest; ours do not. | Flags `shown`. |
| `BEGIN; CREATE FUNCTION f() … BEGIN ATOMIC SELECT 1; SELECT 2; END; CREATE INDEX CONCURRENTLY i ON t(c); COMMIT;` | **Misses the transaction hazard.** It splits the function body at its inner `;`, reads the fragment `END` as the end of the transaction, and then sees the index "outside" it. | Reports the hazard. |

The first and third are false negatives, which matters for a gate. My first summary of this comparison compared only table names and hid the second difference; the statement-level output above is the corrected one. The corpus is 18 hand-picked inputs, not real-world migrations, so this shows the direction but is not a measure of how often it matters.

Other behavior confirmed on the AST path:
* **Line numbers** come from the parser's statement offsets, which are **bytes, not characters**. A multibyte comment before a statement gives the wrong line unless offsets are converted; the prototype handles this and reported the correct line.
* **Remediation by mutation:** setting `concurrent = true` on the parsed `IndexStmt` and deparsing produced `CREATE INDEX CONCURRENTLY idx_b ON …` with `UNIQUE`, `IF NOT EXISTS`, `INCLUDE` and `WHERE` preserved. The `ALTER … TYPE` pieces (`ADD COLUMN "Col_new" numeric(12, 2)` and the `USING` expression) can be built the same way. Deparsing normalizes formatting (for example `t (c)`) and drops comments; our current text-splice keeps the user's original text. Either is acceptable.
* **Extensibility:** the AST exposes things our rules cannot see cheaply, for example adding a foreign key without `NOT VALID` is a field on a constraint node, not a regex.

### Cost

| | Current `dist/index.js` | AST prototype |
| :--- | :--- | :--- |
| JS bundle | 125 KB | 256 KB (parser glue + rules + deparser) |
| Extra file | none | `libpg-query.wasm`, 962 KB |
| Wall time, `--lint`-equivalent on a 1-statement file (5 runs) | ~133 ms | ~162 ms |
| Bare `node -e 0` on the same machine | ~118 ms | ~118 ms |

So the parser adds roughly **30 ms** to a cold start on this machine. Warm parses are sub-millisecond. (This is also why the README no longer claims "<20 ms": bare Node startup alone exceeds it.)

## Risks and how to handle them

1. **A syntax error fails the whole file.** libpg_query returns an error and *no partial tree*, with the byte offset of the problem. Today a statement we can't recognize is silently ignored; with the parser it becomes an explicit failure, which is better, but one bad statement must not hide the other findings. **Mitigation:** try the whole-file parse; on failure, fall back to our tokenizer to split, parse each statement on its own, analyze the ones that parse, and list the ones that don't under "Skipped" (status INCONCLUSIVE, with the line from the error offset). That is exactly the fail-closed model we already have.
2. **psql meta-commands and `COPY … FROM stdin` data blocks do not parse.** Same as today; keep the existing pre-strip of `\` lines, and keep documenting that the baseline should be a schema-only dump.
3. **Grammar version coupling.** The PG16 grammar rejects newer syntax (confirmed with the PG16 build of `@supabase/pg-parser`, which shares libpg_query's grammar: `MERGE … RETURNING` and virtual generated columns, which are PG17/18). A project on PG17+ would see parse failures, reported as INCONCLUSIVE rather than silently passing. Shipping several versions in one `dist/` collides on the WASM filename (seen with `@pgsql/parser`), so the realistic options are: ship PG16 only for now, or ship per-version bundles later. Note that the test Postgres in this repo is 16, so PG16 is also what we can verify end to end.
4. **Supply chain.** The WASM is a compiled binary blob inside an npm package we cannot reproduce from source in CI. `libpg-query` is MIT-licensed, built from `constructive-io/libpg-query-node`, and has **one npm maintainer**, which is a bus-factor risk. Pin the exact version and review each bump. This is a real tradeoff against the current zero-binary bundle.
5. **Repo and package weight.** One WASM file that rarely changes; the `dist/` freshness job already covers it, but `ncc` does not copy it, so the build needs a copy step (and the CI `dist` job needs to cover it).

## Rollout

1. **Shadow mode.** Add the parser behind the same interface as `analyzeDDLLocks`. In CI only, run both implementations over our tests plus a corpus of real migrations (for example the migrations of a few large open-source Rails/Django/Flyway projects) and fail on unexplained differences. No verdict changes.
2. **Switch the rules to the AST**, keeping the tokenizer for the fallback split and for the text-splice remediation. Add the WASM copy step to `npm run build` and the `dist` check.
3. **New rules on the AST only** (for example foreign keys without `NOT VALID`, `NOT NULL` additions), or leave breadth to Squawk (next section) and keep our rule set small.

## Sketch: `--squawk-json <file>`

**Source of the format.** I did not run Squawk. The field list below comes from its Rust source (`ReportViolation` in the reporter, read through a summarizing fetch) and the docs, so confirm it against a real run before building. Per that source, `squawk --reporter json file.sql` prints **one JSON array** of violations, each with:

`file`, `line`, `column`, `line_end`, `column_end` (numbers), `level` (`"Warning"` or `"Error"`), `message` (a single string), `help` (string or null), `rule_name`.

**Design.**
* **Input only.** QueryGuard never executes Squawk (a separate Rust binary). Users run it first: `squawk --reporter json db/migrations/*.sql > squawk.json`, then pass `squawk-json-path` (Action input, default `''`) or `--squawk-json squawk.json`. Backward compatible: absent means no change.
* **Fail closed on the input.** A missing file, invalid JSON, a non-array, or an entry without the expected fields adds a skipped item (`stage: external-lint`, target `squawk-json`) so the run is INCONCLUSIVE, never a quiet pass. An empty array `[]` is valid ("Squawk found nothing"). We cannot prove from `[]` that Squawk ran on *our* migration file; the `file` field of any violation can be cross-checked, and the docs should say so.
* **Informational by default.** Squawk ships many style rules (for example `prefer-bigint-over-int`). Gating on all of them would contradict "only migration hazards fail strict mode". So every Squawk finding is *informational* unless its `rule_name` is listed in an opt-in `squawk-gate-rules` input. I'd rather ship no built-in lock-rule allowlist than hard-code rule names I have not verified against the current Squawk rule set.
* **De-duplicate against our own findings.** Three Squawk rules say the same thing as ours (index creation without `CONCURRENTLY`, column type change, `CONCURRENTLY` in a transaction). When our finding exists, show it once with our tested fix and mark "also flagged by Squawk (`rule`)". The mapping is small and explicit (see appendix), and it is the only place we couple to Squawk's rule names.
* **Report.** A "Squawk findings" table (rule, level, line, message, help) after the migration findings, with the same "not evidence of production safety" posture. The summary line states which tool produced which finding.
* **Transactions.** Squawk has its own `--assume-in-transaction`. We cannot tell how it was invoked, so the docs should say to pass the same setting to both.
* **Line numbers.** I could not confirm from the source whether Squawk's `line` is 0- or 1-based. The merge must not assume; verify with a real run, and add a one-line test.

The merge logic is in the appendix. The prototype compiled against the repo's real `Finding`, `RunOutcome` and `computeStatus`, and showed: advisory by default, a duplicate collapsed into ours, gating only for a listed rule, and a malformed report becoming a skipped item. It did not exercise report rendering, and its "status" output was FAIL in every case only because the demo includes one of our own lock findings.

## Open questions

* **Single-file output.** Can the WASM be embedded so `dist/index.js` really is one file (for example by patching the loader to take a `wasmBinary`, or a build plugin that inlines it)? I did not find a supported option in `libpg-query`; this deserves a short timeboxed look before committing to the two-file layout.
* **Real-world corpus.** The 18-input comparison is too small to size the benefit. The shadow-mode step answers it.
* **Squawk format and line base.** Needs one real run (`squawk-cli` on npm, or the release binaries).
* **Multi-version support.** Whether anyone needs a non-16 grammar, and if so how to ship it without the filename collision.
* **Parser maintenance.** `libpg-query` versions track Postgres majors (16.x has 18 releases); worth checking its release cadence before depending on it.

## Appendix: prototype code

Condensed from the scratch prototype (not in the repo).

**Split and analyze with the parser** (`libpg-query@16.7.3` and `pgsql-deparser`):

```js
const lq = require('libpg-query');
const { deparseSync } = require('pgsql-deparser');
await lq.loadModule();

// Statement ranges come from the parser. Offsets are BYTES; fields equal to 0 are omitted.
const tree = lq.parseSync(sql); // throws SqlError (err.sqlDetails.cursorPosition) on any syntax error
for (const s of tree.stmts) {
  const start = s.stmt_location || 0;
  const end = s.stmt_len ? start + s.stmt_len : buf.length; // last statement has no length
  /* decode buf.subarray(start, end); skip leading comments; line = newlines before start + 1 */
}

// Rules on nodes
//  IndexStmt:        !concurrent -> SHARE;  concurrent && inTx -> TX hazard;  ONLY <=> !relation.inh
//  AlterTableStmt:   cmds[].AlterTableCmd.subtype === 'AT_AlterColumnType' -> ACCESS EXCLUSIVE
//  TransactionStmt:  kind BEGIN/START -> inTx; COMMIT/ROLLBACK -> !inTx; SAVEPOINT/ROLLBACK_TO/PREPARED unchanged

// Remediation by mutation + deparse
node.IndexStmt.concurrent = true;
const fixed = deparseSync(node); // CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_b ON …
```

**Squawk ingest:**

```ts
interface SquawkViolation {
  file: string; line: number; column: number; line_end: number; column_end: number;
  level: 'Warning' | 'Error'; message: string; help: string | null; rule_name: string;
}

type Parsed = { ok: true; violations: SquawkViolation[] } | { ok: false; reason: string };

export function parseSquawkJson(text: string): Parsed { /* JSON.parse; Array.isArray; validate each entry */ }

// Squawk rules equivalent to one of ours; our finding (with its tested fix) wins.
const SAME_AS_OURS: Record<string, (f: Finding) => boolean> = {
  'require-concurrent-index-creation': (f) => f.lockType === 'SHARE',
  'changing-column-type': (f) => f.lockType === 'ACCESS EXCLUSIVE',
  'ban-concurrent-index-creation-in-transaction': (f) => !!f.transactionHazard,
};

export function mergeSquawk(o: RunOutcome, p: Parsed, gateRules: ReadonlySet<string>): void {
  if (!p.ok) {
    o.skipped.push({ stage: 'external-lint', target: 'squawk-json', reason: p.reason }); // => INCONCLUSIVE
    return;
  }
  o.external = p.violations.map((v) => ({
    source: 'squawk', rule: v.rule_name, level: v.level, line: v.line, message: v.message,
    help: v.help ?? undefined,
    gating: gateRules.has(v.rule_name),                       // informational unless opted in
    alsoFlaggedByUs: !!SAME_AS_OURS[v.rule_name] && o.lockFindings.some(SAME_AS_OURS[v.rule_name]),
  }));
}
```

`computeStatus` would add one clause: an external finding with `gating && !alsoFlaggedByUs` yields FAIL.
