import { Finding } from './types';

export function buildMarkdownReport(findings: Finding[]): string {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  
  const criticalCount = findings.filter(f => f.hasSeqScan || f.isLockRisk).length;

  let md = `## 🛡️ QueryGuard Pre-Merge Blast-Radius Report\n\n`;
  md += `*Last evaluated: \`${timestamp}\`*\n\n`;

  if (criticalCount === 0) {
    md += `✅ **All checks passed.** Zero unindexed full table scans and zero blocking migration locks detected.\n`;
    return md;
  }

  md += `⚠️ **High Blast-Radius Warning:** Detected **${criticalCount}** risky database pattern(s).\n\n`;
  md += `| Severity | Issue Type | Target Table | Blast Radius | Suggested Fix |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- |\n`;

  for (const f of findings) {
    if (f.isLockRisk) {
      const blastDesc = f.lockType === 'ACCESS EXCLUSIVE'
        ? 'Forces table rewrite; blocks all reads and writes'
        : 'Blocks concurrent table writes (`INSERT`/`UPDATE`/`DELETE`)';
      
      md += `| 🚨 CRITICAL | \`${f.lockType}\` Lock | \`${f.targetTable || 'unknown'}\` | ${blastDesc} | \`${f.recommendation || ''}\` |\n`;
    } else if (f.hasSeqScan) {
      const blastDesc = `Scans ~${f.impactedRows?.toLocaleString() || '0'} rows (Cost: ${f.totalCost.toFixed(1)})`;
      md += `| 🚨 CRITICAL | Full Table Scan | \`${f.targetTable || 'unknown'}\` | ${blastDesc} | \`${f.recommendation || ''}\` |\n`;
    }
  }

  md += `\n<details><summary><b>View Impacted Statements</b></summary>\n\n`;
  for (const f of findings) {
    if (f.isLockRisk || f.hasSeqScan) {
      md += `\`\`\`sql\n${f.query}\n\`\`\`\n`;
    }
  }
  md += `</details>\n`;

  return md;
}
