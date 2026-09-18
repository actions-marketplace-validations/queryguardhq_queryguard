"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMarkdownReport = buildMarkdownReport;
function buildMarkdownReport(findings) {
    const severe = findings.filter(f => f.hasSeqScan);
    let md = `## 🛡️ QueryGuard Pre-Merge Blast-Radius Report\n\n`;
    if (severe.length === 0) {
        md += `✅ **All evaluated queries execute indexed scans.** Zero full table scans detected.\n`;
        return md;
    }
    md += `⚠️ **High Blast-Radius Warning:** Detected **${severe.length}** full sequential table scan(s).\n\n`;
    md += `| Severity | Target Table | Est. Rows Scanned | Planner Cost | Suggested Fix |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- |\n`;
    for (const f of severe) {
        const table = f.targetTable || 'unknown';
        const rows = (f.impactedRows || 0).toLocaleString();
        const cost = f.totalCost.toFixed(1);
        const rec = f.recommendation ? `\`${f.recommendation}\`` : 'Add index';
        md += `| 🚨 CRITICAL | \`${table}\` | ~${rows} | ${cost} | ${rec} |\n`;
    }
    md += `\n<details><summary><b>View Impacted Queries</b></summary>\n\n`;
    const uniqueQueries = Array.from(new Set(severe.map(s => s.query)));
    for (const q of uniqueQueries) {
        md += `\`\`\`sql\n${q};\n\`\`\`\n`;
    }
    md += `</details>\n`;
    return md;
}
