import type { DomainCandidate } from '../types/candidate.js';

export interface CheckpointData {
  runId: string;
  lastCompletedStage: string;
  passed: DomainCandidate[];
  filtered: DomainCandidate[];
  allStageResults: Record<
    string,
    { passed: DomainCandidate[]; filtered: DomainCandidate[]; durationMs: number }
  >;
}

export interface CheckpointStore {
  save(
    runId: string,
    stageName: string,
    passed: DomainCandidate[],
    filtered: DomainCandidate[],
    stageDurationMs: number,
    cumulativePassed: DomainCandidate[],
    cumulativeFiltered: DomainCandidate[],
  ): Promise<void>;
  load(runId: string): Promise<CheckpointData | null>;
  getLastCompletedStage(runId: string): Promise<string | null>;
  clear(runId: string): Promise<void>;
}
