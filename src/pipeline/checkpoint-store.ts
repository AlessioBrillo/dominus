// SPDX-License-Identifier: AGPL-3.0-only
import type { DomainCandidate } from '../types/candidate.js';

/**
 * Version of the persisted checkpoint payload. Bump when the stored
 * candidate/verdict shape changes so older rows are ignored on resume.
 */
export const CHECKPOINT_FORMAT_VERSION = 1;

/**
 * Hard ceiling on checkpoint age. A run resumed beyond this is a different
 * world: deploy changes, DNS verdicts go stale, provider configs shift.
 * Resume is skipped for older checkpoints (ADR-0037 hardening).
 */
export const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Validates that a deserialized DomainCandidate has the minimum required
 * fields for the current schema version. Returns false if the candidate
 * is missing critical fields (e.g., from an older schema).
 */
function validateCandidate(candidate: unknown, version: number): candidate is DomainCandidate {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  // Required fields present in all versions
  if (typeof c.domain !== 'string') return false;
  if (typeof c.source !== 'string') return false;
  if (typeof c.status !== 'string') return false;
  // Version-specific fields
  if (version >= 1) {
    // forceWhoisRecheck was added in v1
    if (c.forceWhoisRecheck !== undefined && typeof c.forceWhoisRecheck !== 'boolean') return false;
    // whoisMeta is optional but if present must be object
    if (c.whoisMeta !== undefined && typeof c.whoisMeta !== 'object') return false;
  }
  return true;
}

export { validateCandidate };

export interface StageCheckpoint {
  passed: DomainCandidate[];
  filtered: DomainCandidate[];
  durationMs: number;
  formatVersion: number;
}

export interface CheckpointData {
  runId: string;
  lastCompletedStage: string;
  passed: DomainCandidate[];
  filtered: DomainCandidate[];
  allStageResults: Record<string, StageCheckpoint>;
  formatVersion: number;
}

export interface CheckpointStore {
  save(
    runId: string,
    stageName: string,
    passed: DomainCandidate[],
    filtered: DomainCandidate[],
    stageDurationMs: number,
    cumulativePassed?: DomainCandidate[],
    cumulativeFiltered?: DomainCandidate[],
  ): Promise<void>;
  load(runId: string): Promise<CheckpointData | null>;
  getLastCompletedStage(runId: string): Promise<string | null>;
  hasCheckpoint(runId: string): Promise<boolean>;
  clear(runId: string): Promise<void>;
}
