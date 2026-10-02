/** Version of the on-disk snapshot layout; bumped only for incompatible changes. */
export const FORMAT_VERSION = 1;

export type SnapshotStatus = 'COMPLETE' | 'PARTIAL';

/** Why a snapshot is PARTIAL. `scope` names the part that is missing or incomplete. */
export interface PartialReason {
  scope: string;
  reason: string;
}

export interface Manifest {
  format_version: number;
  created_at: string;
  label: string;
  server_version_num: number;
  mode: 'shape' | 'full';
  status: SnapshotStatus;
  partial_reasons: PartialReason[];
  tool_version: string;
}

/** COMPLETE and PARTIAL write an artifact; FAILED writes nothing and leaves any previous snapshot alone. */
export const SNAPSHOT_EXIT = { COMPLETE: 0, FAILED: 1, PARTIAL: 2 } as const;
