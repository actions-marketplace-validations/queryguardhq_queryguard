import { Finding, RunOutcome, SkippedItem, StatementError, Status } from './types';
import { computeStatus, failsGate } from './status';

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function failureBlock(title: string, e: StatementError): string {
  return (
    `### ${title}\n\n` +
    `Statement at line ${e.line}:\n\n\`\`\`sql\n${e.statement}\n\`\`\`\n\n` +
    `Postgres error: \`${e.message.replace(/`/g, "'")}\`\n\n`
  );
}

function statusHeadline(status: Status, o: RunOutcome): string {
  const skipped = o.skipped.length + (o.baselineFailure ? 1 : 0);
  switch (status) {
    case 'PASS':
      return `✅ **Status: PASS** — all checks ran and no blocking migration locks were detected.\n\n`;
    case 'FAIL':
      return o.migrationFailure
        ? `❌ **Status: FAIL** — the migration did not apply cleanly.\n\n`
        : `❌ **Status: FAIL** — blocking migration lock(s) or transaction hazard(s) detected.\n\n`;
    case 'INCONCLUSIVE':
      return (
        `⚠️ **Status: INCONCLUSIVE** — ${skipped} check(s) could not run, so this report is **not** a pass. ` +
        `See "Skipped" below.\n\n`
      );
  }
}

function fixesSection(findings: Finding[], heading = 'Suggested fixes'): string {
  let md = '';
  for (const f of findings) {
    const r = f.remediation;
    if (!r || (r.sql.length === 0 && r.notes.length === 0)) continue;
    md += `**\`${cell(f.targetTable || 'unknown')}\`** — ${r.summary}\n\n`;
    if (r.sql.length > 0) md += `\`\`\`sql\n${r.sql.join('\n')}\n\`\`\`\n\n`;
    for (const note of r.notes) md += `- ${note}\n`;
    if (r.notes.length > 0) md += `\n`;
  }
  return md ? `### ${heading}\n\n${md}` : '';
}

function skippedTable(items: SkippedItem[]): string {
  let md = `### Skipped (not checked)\n\n`;
  md += `| Stage | Target | Line | Reason |\n| :--- | :--- | :--- | :--- |\n`;
  for (const s of items) {
    md += `| ${s.stage} | \`${cell(s.target)}\` | ${s.line ?? ''} | ${cell(s.reason)} |\n`;
  }
  return md + `\n`;
}

function lockRows(findings: Finding[]): string {
  let md = `| Severity | Issue Type | Target Table | Impact | Suggested Fix |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- |\n`;
  for (const f of findings) {
    if (f.transactionHazard) {
      md += `| 🚨 CRITICAL | \`CONCURRENTLY\` in a transaction | \`${cell(f.targetTable || 'unknown')}\` | Fails at deploy: \`CREATE INDEX CONCURRENTLY\` cannot run inside a transaction block | ${cell(f.recommendation || '')} |\n`;
      continue;
    }
    const blastDesc =
      f.lockType === 'ACCESS EXCLUSIVE'
        ? 'Forces table rewrite; blocks all reads and writes'
        : 'Blocks concurrent table writes (`INSERT`/`UPDATE`/`DELETE`)';
    md += `| 🚨 CRITICAL | \`${f.lockType}\` Lock | \`${cell(f.targetTable || 'unknown')}\` | ${blastDesc} | ${cell(f.recommendation || '')} |\n`;
  }
  return md;
}

/** Sequential scans: informational only. They never affect status, exit code or fail-on-sev1. */
function seqScanSection(scans: Finding[], rows: number | undefined): string {
  const on = rows ? `~${rows.toLocaleString()} synthetic rows per table` : 'synthetic rows';
  let md = `### ℹ️ Informational: sequential scan on synthetic data\n\n`;
  md += `Plans were produced from ${on}, not production data. A sequential scan here is a hint, not evidence of a problem, and does not affect the status above.\n\n`;
  if (scans.length > 0) {
    md += `| Table | Est. rows returned | Cost | Suggestion |\n| :--- | :--- | :--- | :--- |\n`;
    for (const f of scans) {
      md += `| \`${cell(f.targetTable || 'unknown')}\` | ~${f.impactedRows?.toLocaleString() ?? '?'} | ${f.totalCost.toFixed(1)} | ${cell(f.recommendation || '')} |\n`;
    }
    md += `\n${fixesSection(scans, 'Suggested indexes (optional)')}`;
    md += `<details><summary>Queries with a sequential scan</summary>\n\n`;
    for (const f of new Set(scans.map((x) => x.query))) md += `\`\`\`sql\n${f}\n\`\`\`\n`;
    md += `</details>\n\n`;
  } else {
    md += `No sequential scans were found on the synthetic data.\n\n`;
  }
  md += `> **A clean query section is not evidence of production safety.** Synthetic data cannot reproduce production row counts, skew or statistics.\n`;
  return md;
}

export function buildMarkdownReport(o: RunOutcome, now: Date = new Date()): string {
  const status = computeStatus(o);
  const timestamp = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  const locks = o.lockFindings.filter(failsGate);
  const scans = o.scanFindings.filter((f) => f.hasSeqScan);

  let md = `## 🛡️ QueryGuard Report\n\n`;
  md += statusHeadline(status, o);
  md += `*Last evaluated: \`${timestamp}\`*\n\n`;
  if (o.assumedTransaction) {
    md += `*Assuming the migration runner wraps the file in a transaction (\`assume-in-transaction\`).*\n\n`;
  }

  if (o.migrationFailure) md += failureBlock('Migration failed', o.migrationFailure);
  if (o.baselineFailure) md += failureBlock('Baseline schema failed (starting state could not be built)', o.baselineFailure);
  if (o.skipped.length > 0) md += skippedTable(o.skipped);

  if (locks.length > 0) {
    md += `### Migration findings\n\n${lockRows(locks)}\n${fixesSection(locks)}`;
    md += `<details><summary><b>View Impacted Statements</b></summary>\n\n`;
    for (const f of locks) md += `\`\`\`sql\n${f.query}\n\`\`\`\n`;
    md += `</details>\n\n`;
  } else if (status === 'PASS') {
    md += `No blocking migration locks detected.\n\n`;
  }

  if (o.queriesEvaluatedOn !== undefined) md += seqScanSection(scans, o.queriesEvaluatedOn);

  return md;
}
