"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMarkdownReport = buildMarkdownReport;
function buildMarkdownReport(findings) {
    const severe = findings.filter(f => f.hasSeqScan || f.isLockRisk);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    let md = `## 🛡️ QueryGuard Pre-Merge Blast-Radius Report\n\n`;
    md += `*Last evaluated: \`${now}\`*\n\n`;
    if (severe.length === 0) {
        md += `✅ **All checks passed.** Zero unindexed full table scans and zero blocking migration locks detected.\n`;
        return md;
    }
    md += `⚠️ **High Blast-Radius Warning:** Detected **${severe.length}** risky database pattern(s).\n\n`;
    md += `| Severity | Issue Type | Target Table | Blast Radius | Suggested Fix |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- |\n`;
    for (const f of severe) {
        const table = f.targetTable || 'unknown';
        if (f.isLockRisk) {
            const lockLabel = f.lockType || 'ACCESS EXCLUSIVE';
            const blastRadius = lockLabel === 'SHARE'
                ? 'Blocks concurrent table writes (`INSERT`/`UPDATE`/`DELETE`)'
                : 'Blocks all concurrent `SELECT` queries and writes';
            md += `| 🚨 CRITICAL | \`${lockLabel}\` Lock | \`${table}\` | ${blastRadius} \vert{}${f.recommendation} |\n`;
        }
        else {
            const rows = (f.impactedRows || 0).toLocaleString();
            const cost = f.totalCost.toFixed(1);
            const rec = f.recommendation ? `\`${f.recommendation}\`` : 'Add covering index';
            md += `| 🚨 CRITICAL | Full Table Scan | \`${table}\` | Scans ~${rows} rows (Cost: ${cost}) | ${rec} |\n`;
        }
    }
    md += `\n<details><summary><b>View Impacted Statements</b></summary>\n\n`;
    const uniqueStatements = Array.from(new Set(severe.map(s => s.query)));
    for (const stmt of uniqueStatements) {
        md += `\`\`\`sql\n${stmt};\n\`\`\`\n`;
    }
    md += `</details>\n`;
    return md;
}
