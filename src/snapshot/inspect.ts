// `queryguard snapshot inspect <dir>`: what a security reviewer reads before approving a snapshot.
import { approxBytes, approxCount, age, ageInDays, duration, pgVersion, windowLabel } from './display';
import { Snapshot } from './load';
import { displayName } from './shape';

const TOP = 10;
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]))).join('  ')}`.trimEnd()).join('\n');
}

export function renderInspect(s: Snapshot, fileCount: number, now: Date = new Date(), maxAgeDays = 14): string {
  const m = s.manifest;
  const out: string[] = [];
  const line = (text = '') => out.push(text);
  const field = (name: string, value: string) => line(`  ${pad(name, 13)}${value}`);

  line(`QueryGuard snapshot: ${m.label}`);
  field('Status', m.status === 'COMPLETE' ? 'COMPLETE' : `PARTIAL (${m.partial_reasons.length} reason${m.partial_reasons.length === 1 ? '' : 's'}, below)`);
  const days = ageInDays(m.created_at, now);
  field('Taken', `${m.created_at.replace('T', ' ').slice(0, 16)} UTC (${age(m.created_at, now)})${days > maxAgeDays ? `: older than ${maxAgeDays} days, so the Action will warn that it is stale` : ''}`);
  field('Server', `PostgreSQL ${pgVersion(m.server_version_num)}`);
  field('Mode', m.mode === 'full' ? `full (stats.sql has value statistics for ${m.allowed_columns!.length} allow-listed column(s))` : 'shape (no value from any row)');
  field('Precision', m.precision === 'approx' ? 'approx: counts, sizes and times rounded to 2 significant figures' : 'exact');
  field(
    'schema.sql',
    m.schema_source.kind === 'pg_dump'
      ? `pg_dump ${m.schema_source.pg_dump_version} --schema-only`
      : `supplied file (--schema-from)${m.schema_source.pg_dump_version ? `, made by pg_dump ${m.schema_source.pg_dump_version}` : ''}`
  );
  field('Integrity', `${fileCount} files match their SHA-256 in manifest.json; valid against schema/snapshot.v1.json (format ${m.format_version})`);
  field('Tool', `QueryGuard ${m.tool_version}`);

  if (m.partial_reasons.length > 0) {
    line();
    line('Partial: not everything could be collected');
    for (const p of m.partial_reasons) line(`  - ${p.scope}: ${p.reason}`);
  }

  // Contents
  const rels = s.shape.relations;
  const kinds = new Map<string, number>();
  for (const r of rels) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  const columns = rels.flatMap((r) => r.columns);
  line();
  line('Contents');
  const KIND: Record<string, string> = { table: 'table', partitioned_table: 'partitioned table', matview: 'materialized view', foreign_table: 'foreign table' };
  field('Relations', `${rels.length} (${[...kinds].map(([k, n]) => `${n} ${KIND[k]}${n === 1 ? '' : 's'}`).join(', ')}), ${s.shape.indexes.length} indexes`);
  field('Columns', `${columns.length}, ${columns.filter((c) => c.stats.length > 0).length} with statistics (from ${s.shape.column_stats_source})`);
  const w = s.workload;
  field(
    'Workload',
    w.source
      ? `${w.statements.length} statements: the top ${w.selection.top} by total time and by calls, of ${w.selection.candidates} candidates; ${windowLabel(s)}`
      : 'none (see Partial)'
  );
  const unresolved = w.statements.filter((st) => st.unresolved_count > 0).length;
  if (unresolved > 0) field('', `${unresolved} statement(s) reference relations outside the snapshot (views, or ambiguous names)`);

  // Largest tables
  const sized = rels.filter((r) => r.size_bytes).sort((a, b) => b.size_bytes!.total - a.size_bytes!.total).slice(0, TOP);
  if (sized.length > 0) {
    line();
    line(`Largest tables (by total size, top ${Math.min(TOP, sized.length)})`);
    out.push(
      table([
        ['relation', 'rows', 'size', 'of which indexes', 'statements'],
        ...sized.map((r) => {
          const name = displayName(r.schema, r.name);
          return [
            name,
            r.reltuples === null ? '?' : approxCount(r.reltuples),
            approxBytes(r.size_bytes!.total),
            approxBytes(r.size_bytes!.indexes),
            String(w.statements.filter((st) => st.relations.includes(name)).length),
          ];
        }),
      ])
    );
  }

  // Hottest statements
  if (w.statements.length > 0) {
    const hot = [...w.statements].sort((a, b) => b.total_exec_ms - a.total_exec_ms).slice(0, TOP);
    line();
    line(`Hottest query shapes (by total execution time, top ${hot.length})`);
    out.push(
      table([
        ['calls', 'total', 'mean', 'relations', 'text'],
        ...hot.map((st) => [approxCount(st.calls), duration(st.total_exec_ms), duration(st.mean_exec_ms), st.relations.join(', ') || '-', clip(st.text, 80)]),
      ])
    );
  }

  // Redaction report, in full
  const r = s.redactions;
  line();
  line('What left production, and what did not');
  if (m.mode === 'full') {
    line(`  Value statistics (most common values, histograms) of the allow-listed columns, in stats.sql:`);
    for (const c of m.allowed_columns!) line(`    - ${c}`);
    line('  Every other column: shape only (null fraction, width, distinct count, correlation, frequencies).');
  } else {
    line('  Column statistics: shape only (null fraction, width, distinct count, correlation, frequencies), never values.');
  }
  line(`  Workload: ${r.workload.entries_read} pg_stat_statements entries read for this database.`);
  const ex = r.workload.excluded;
  line(`    Excluded: ${ex.not_dml} utility commands, ${ex.text_hidden} with text hidden by privileges, ${ex.system_only} touching only system catalogs, ${ex.no_relations} touching no relation.`);
  line(`    Comments removed from ${r.workload.comments_removed} kept statement(s).`);
  const redacted = (label: string, ids: string[]) =>
    line(`    Text replaced (${label}): ${ids.length === 0 ? 'none' : `${ids.length}, queryids ${ids.join(', ')}`}`);
  redacted('a literal survived normalization', r.workload.redacted.literal);
  redacted('could not be parsed with confidence', r.workload.redacted.unparseable);
  if (w.source && w.source.dealloc > 0) {
    line(`    pg_stat_statements evicted entries (dealloc ${approxCount(w.source.dealloc)}); that is when constants can survive normalization, which the redaction above covers.`);
  }
  const entries = Object.entries(r.schema.removed_entries);
  line(`  schema.sql: objects removed: ${entries.length === 0 ? 'none' : entries.map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  const rl = r.schema.removed_lines;
  line(`    Lines removed: ${rl.owner} owner, ${rl.restrict} \\restrict, ${rl.connect} \\connect.`);
  line('  Never collected: host, port, user, database name, role names, partial-index predicates.');
  line('  Read schema.sql in full: it contains every object definition, including view and function bodies.');
  return out.join('\n') + '\n';
}
