import { RunOutcome, Status } from './types';

/**
 * Only migration hazards can fail the gate: lock findings, and statements that cannot run
 * inside the transaction they are in. Sequential scans are measured on synthetic rows and
 * are informational, so they never affect status, exit code or fail-on-sev1.
 */
export function failsGate(f: { isLockRisk?: boolean; transactionHazard?: boolean }): boolean {
  return !!f.isLockRisk || !!f.transactionHazard;
}

/**
 * FAIL beats INCONCLUSIVE beats PASS: a known hazard is definitive,
 * while a skipped check only means we cannot vouch for the result.
 */
export function computeStatus(o: RunOutcome): Status {
  const findings = [...o.lockFindings, ...o.scanFindings];
  if (o.migrationFailure || findings.some(failsGate)) return 'FAIL';
  if (o.baselineFailure || o.skipped.length > 0) return 'INCONCLUSIVE';
  return 'PASS';
}

export const EXIT_CODES: Record<Status, number> = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 };
