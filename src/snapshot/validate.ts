import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import schema from '../../schema/snapshot.v1.json';

let validator: ValidateFunction | undefined;

/**
 * Validates the JSON files of a snapshot, as `{ manifest, shape, workload, redactions }`, against
 * the published schema/snapshot.v1.json. Returns one line per problem; empty means valid.
 * Used when writing (our own output must pass) and when loading.
 */
export function validateSnapshot(bundle: unknown): string[] {
  validator ??= new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (validator(bundle)) return [];
  return (validator.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && 'additionalProperty' in e.params ? `: ${e.params.additionalProperty}` : ''}`);
}
