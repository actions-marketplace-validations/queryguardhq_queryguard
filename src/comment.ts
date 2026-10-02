/** Hidden marker that identifies QueryGuard's PR comment so reruns update it in place. */
export const BOT_MARKER = '<!-- queryguard:report -->';

/**
 * Marker written by releases up to 1.2.x. Still recognized, so a PR that already has a
 * comment from an older version is updated in place instead of getting a second one.
 */
export const LEGACY_BOT_MARKER = '<!-- queryguard:blast-radius-report -->';

export function withMarker(report: string): string {
  return `${BOT_MARKER}\n${report}`;
}

/** The existing QueryGuard comment, whichever marker it carries. */
export function findReportComment<T extends { body?: string | null }>(comments: unknown): T | undefined {
  if (!Array.isArray(comments)) return undefined;
  return comments.find(
    (c: T) => !!c.body && (c.body.includes(BOT_MARKER) || c.body.includes(LEGACY_BOT_MARKER))
  );
}
