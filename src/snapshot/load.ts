import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Manifest, Redactions, Shape, Workload } from './types';
import { validateSnapshot } from './validate';
import { ARTIFACT_FILES } from './writer';

export interface Snapshot {
  dir: string;
  manifest: Manifest;
  shape: Shape;
  workload: Workload;
  redactions: Redactions;
  schemaSql: string;
}

export type LoadResult = { ok: true; snapshot: Snapshot } | { ok: false; errors: string[] };

export const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

/**
 * Loads a snapshot directory and refuses anything it cannot vouch for: a missing or unlisted file,
 * a file whose SHA-256 differs from the manifest, unparseable JSON, or JSON that does not validate
 * against schema/snapshot.v1.json.
 */
export function loadSnapshot(dir: string): LoadResult {
  const errors: string[] = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, errors: [`${dir} is not a directory`] };

  const read = (name: string): Buffer | null => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  };
  const manifestRaw = read('manifest.json');
  if (!manifestRaw) return { ok: false, errors: ['manifest.json is missing'] };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8'));
  } catch (err: any) {
    return { ok: false, errors: [`manifest.json is not valid JSON: ${err.message}`] };
  }
  if (manifest?.format_version !== 1) {
    return { ok: false, errors: [`unsupported format_version ${JSON.stringify(manifest?.format_version)} (this QueryGuard reads 1)`] };
  }

  const listed = manifest.files && typeof manifest.files === 'object' ? manifest.files : {};
  for (const name of fs.readdirSync(dir)) {
    if (name === 'manifest.json') continue;
    if (!(ARTIFACT_FILES as readonly string[]).includes(name) || !(name in listed)) errors.push(`${name} is not listed in manifest.json`);
  }
  const contents: Record<string, Buffer> = {};
  for (const [name, digest] of Object.entries(listed)) {
    const content = read(name);
    if (!content) errors.push(`${name} is listed in manifest.json but missing`);
    else if (sha256(content) !== digest) errors.push(`${name} does not match its SHA-256 in manifest.json (edited after it was written?)`);
    else contents[name] = content;
  }

  const parse = (name: string): unknown => {
    if (!contents[name]) return undefined;
    try {
      return JSON.parse(contents[name].toString('utf8'));
    } catch (err: any) {
      errors.push(`${name} is not valid JSON: ${err.message}`);
      return undefined;
    }
  };
  const bundle = { manifest, shape: parse('shape.json'), workload: parse('workload.json'), redactions: parse('redactions.json') };
  if (errors.length > 0) return { ok: false, errors };

  const invalid = validateSnapshot(bundle);
  if (invalid.length > 0) return { ok: false, errors: invalid.map((e) => `schema: ${e}`) };

  return {
    ok: true,
    snapshot: {
      dir,
      manifest,
      shape: bundle.shape as Shape,
      workload: bundle.workload as Workload,
      redactions: bundle.redactions as Redactions,
      schemaSql: contents['schema.sql'].toString('utf8'),
    },
  };
}
