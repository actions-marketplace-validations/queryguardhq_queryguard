import * as fs from 'fs';
import * as path from 'path';

/** Every file a snapshot directory may contain. Anything else means the directory is not ours. */
export const ARTIFACT_FILES = ['manifest.json', 'schema.sql', 'shape.json', 'workload.json', 'redactions.json', 'stats.sql'] as const;
export type ArtifactFile = (typeof ARTIFACT_FILES)[number];

/** Codepoint order: the same on every machine and server, unlike locale collation. */
export const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with object keys sorted at every level, 2-space indent and a final newline, so refreshes diff cleanly. */
export function stableStringify(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort(byCodepoint)
          .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

/**
 * Writes the artifact into a temporary sibling directory, then swaps it into place, so a failed
 * run never leaves a half-written snapshot. An existing directory is replaced only if it holds
 * nothing but snapshot files: pointing --out at the wrong place must not delete anything.
 */
export function writeArtifact(outDir: string, files: Partial<Record<ArtifactFile, string>>): void {
  const target = path.resolve(outDir);
  const parent = path.dirname(target);

  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new Error(`${outDir} exists and is not a directory`);
    const foreign = fs.readdirSync(target).filter((f) => !(ARTIFACT_FILES as readonly string[]).includes(f));
    if (foreign.length > 0) {
      throw new Error(
        `${outDir} contains files that are not part of a snapshot (${foreign.slice(0, 5).join(', ')}); refusing to replace it`
      );
    }
  }

  fs.mkdirSync(parent, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.tmp-`));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmp, name), content);
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }

  if (fs.existsSync(target)) {
    const old = `${tmp}.old`;
    fs.renameSync(target, old);
    fs.renameSync(tmp, target);
    fs.rmSync(old, { recursive: true, force: true });
  } else {
    fs.renameSync(tmp, target);
  }
}
