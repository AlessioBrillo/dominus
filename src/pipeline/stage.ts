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

export interface DnsConsensusStats {
  /** Available verdicts independently confirmed by the secondary provider. */
  verified: number;
  /** Definitive disagreements (secondary says Registered) — valid answers. */
  disagreed: number;
  /** Domains the secondary could not answer at all (errors, timeouts). */
  unverifiable: number;
  /**
   * Available verdicts the tertiary leg rescued (ADR-0045): the secondary
   * could not answer and the tertiary confirmed Available. Present only
   * when > 0.
   */
  tertiaryRescued?: number;
  /** True when the run was flagged degraded over consensus (ADR-0039). */
  degraded: boolean;
}

export interface RdapConsensusStats {
  /** Available verdicts independently confirmed by the second provider (ADR-0050). */
  verified: number;
  /** Definitive disagreements (second leg says Registered) — valid answers. */
  disagreed: number;
  /** Domains the second leg could not answer at all (errors, timeouts). */
  unverifiable: number;
  /**
   * Domains the opt-in WHOIS rescue leg recovered (ADR-0051): the second
   * RDAP leg could not answer and WHOIS confirmed Available. Present only
   * when > 0.
   */
  whoisRescued?: number;
  /**
   * Verdicts skipped because the second leg's origin was authoritative for
   * the candidate's TLD — the 2-of-2 would have been a rubber stamp
   * (ADR-0058). Present only when > 0.
   */
  originOverlap?: number;
  /** True when the run was flagged degraded over consensus (ADR-0039 pattern). */
  degraded: boolean;
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
  /** Per-run 2-of-3 DNS consensus tallies, when the stage ran consensus. */
  consensusStats?: DnsConsensusStats;
  /** Per-run 2-of-2 RDAP consensus tallies, when the stage ran consensus. */
  rdapConsensusStats?: RdapConsensusStats;
}

export interface Stage<TIn, TOut = TIn> {
  readonly name: string;
  process(items: TIn[], signal?: AbortSignal): Promise<StageResult<TOut>>;
}
