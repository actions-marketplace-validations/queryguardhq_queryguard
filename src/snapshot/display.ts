// Human-readable figures, shared by `snapshot inspect` and the Action's annotations. Snapshot
// figures are approximate by design (2 significant figures by default), so they print with "~".
import { Snapshot } from './load';
import { WorkloadStatement } from './types';

const trim = (n: number) => String(Number(n.toPrecision(2)));

/** 48213551 → "~48M", 5000 → "~5,000", 12 → "12". */
export function approxCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `~${Number(n.toPrecision(2)).toLocaleString('en-US')}`;
  for (const [unit, size] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['k', 1e3]] as const) {
    if (n >= size) return `~${trim(n / size)}${unit}`;
  }
  return String(n);
}

/** Bytes in the units pg_size_pretty uses (powers of 1024): 15032385536 → "~14 GB". */
export function approxBytes(n: number): string {
  for (const [unit, size] of [['TB', 1024 ** 4], ['GB', 1024 ** 3], ['MB', 1024 ** 2], ['kB', 1024]] as const) {
    if (n >= size) return `~${trim(n / size)} ${unit}`;
  }
  return `${n} bytes`;
}

/** Milliseconds: 0.0114 → "0.011 ms", 81000000 → "~23 h". */
export function duration(ms: number): string {
  if (ms < 1000) return `${trim(ms)} ms`;
  const s = ms / 1000;
  if (s < 120) return `~${trim(s)} s`;
  if (s < 7200) return `~${trim(s / 60)} min`;
  if (s < 172_800) return `~${trim(s / 3600)} h`;
  return `~${trim(s / 86_400)} days`;
}

/** Calls per second: 2134.5 → "~2,100 calls/s", 0.02 → "~1.2 calls/min". */
export function rate(perSecond: number): string {
  if (perSecond >= 1) return `~${Number(perSecond.toPrecision(2)).toLocaleString('en-US')} calls/s`;
  if (perSecond * 60 >= 1) return `~${trim(perSecond * 60)} calls/min`;
  return `~${trim(perSecond * 3600)} calls/h`;
}

/** "3 days ago", "5 hours ago", "just now". */
export function age(from: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - Date.parse(from)) / 1000);
  if (s < 90) return 'just now';
  const [n, unit] = s < 5400 ? [s / 60, 'minute'] : s < 129_600 ? [s / 3600, 'hour'] : [s / 86_400, 'day'];
  const r = Math.round(n);
  return `${r} ${unit}${r === 1 ? '' : 's'} ago`;
}

export const ageInDays = (from: string, now: Date) => (now.getTime() - Date.parse(from)) / 86_400_000;

/**
 * Seconds the workload counters cover: the sample window, or from the pg_stat_statements reset to
 * the snapshot. Null when unknown (no reset time recorded, or no workload).
 */
export function workloadSeconds(s: Snapshot): number | null {
  const src = s.workload.source;
  if (!src) return null;
  if (src.window.kind === 'sampled') return src.window.seconds;
  if (!src.stats_reset) return null;
  const seconds = (Date.parse(s.manifest.created_at) - Date.parse(src.stats_reset)) / 1000;
  return seconds > 0 ? seconds : null;
}

/** "since the pg_stat_statements reset on 2026-09-01", or "sampled over 300 s". */
export function windowLabel(s: Snapshot): string {
  const src = s.workload.source;
  if (!src) return 'no workload';
  if (src.window.kind === 'sampled') return `sampled over ${src.window.seconds} s`;
  return src.stats_reset ? `average since the pg_stat_statements reset on ${src.stats_reset.slice(0, 10)}` : 'since an unknown reset time';
}

/** Statements that reference `relation` (`schema.name`). */
export const statementsTouching = (s: Snapshot, relation: string): WorkloadStatement[] =>
  s.workload.statements.filter((st) => st.relations.includes(relation));

export const pgVersion = (num: number) => `${Math.floor(num / 10000)}.${num % 100}`;
