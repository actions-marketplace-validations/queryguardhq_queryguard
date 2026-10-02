// Postgres 16 keywords that cannot be used as bare identifiers
// (pg_get_keywords() with catcode R or T).
const MUST_QUOTE = new Set(
  `all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate
collation column concurrently constraint create cross current_catalog current_date current_role current_schema
current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for
foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral
leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer
overlaps placing primary references returning right select session_user similar some symmetric system_user
table tablesample then to trailing true union unique user using variadic verbose when where window with`.split(/\s+/)
);

/** Quote an identifier only when Postgres requires it. */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !MUST_QUOTE.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedName(schema: string | undefined, name: string): string {
  return schema && schema !== 'public' ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

/** `idx_<table>_<col>` made of safe characters and capped at Postgres's 63-byte limit. */
export function indexNameFor(table: string, column: string): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return `idx_${safe(table)}_${safe(column)}`.substring(0, 63);
}

/** Append a suffix to an identifier written as in the source (bare or "quoted"). */
export function suffixIdent(raw: string, suffix: string): string {
  return raw.startsWith('"') ? `${raw.slice(0, -1)}${suffix}"` : `${raw}${suffix}`;
}

/** The unquoted name an identifier token refers to. */
export function identValue(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
}
