// SPDX-License-Identifier: AGPL-3.0-only
export type StageDegradationReason = 'timeout' | 'error' | 'consensus-unverified';

export interface StageDegradation {
  stageName: string;
  reason: StageDegradationReason;
  /** Number of input candidates the stage processed before degrading. */
  processedCount: number;
  /** Number of input candidates the stage was expected to process. */
  expectedCount: number;
  message?: string;
}

export interface StageResult<T> {
  passed: T[];
  filtered: T[];
  stageName: string;
  durationMs: number;
  /**
   * Degradations reported by the stage's own execution (fail-closed paths
   * that still produced partial output). The orchestrator merges these into
   * the run's `degradedReasons`. Empty/undefined means the stage is clean.
   */
  degradations?: StageDegradation[];
}

export interface Stage<TIn, TOut = TIn> {
  readonly name: string;
  process(items: TIn[], signal?: AbortSignal): Promise<StageResult<TOut>>;
}
