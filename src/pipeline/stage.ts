// SPDX-License-Identifier: AGPL-3.0-only
export type StageDegradationReason =
  'timeout' | 'error' | 'consensus-unverified' | 'consensus-disabled-runtime' | 'consensus-runtime-degraded';

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
  /**
   * Domains the tertiary leg could not answer at all (errors, timeouts).
   * Present only when > 0. (ADR-0066)
   */
  tertiaryUnverifiable?: number;
  /**
   * Definitive disagreements from the tertiary leg (tertiary says Registered)
   * — valid answers that veto the domain. Present only when > 0. (ADR-0066)
   */
  tertiaryDisagreed?: number;
  /** True when the run was flagged degraded over consensus (ADR-0039). */
  degraded: boolean;
  /** True when the tertiary leg was flagged degraded (ADR-0066). */
  tertiaryDegraded?: boolean;
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
   * Domains rescued via per-TLD forced WHOIS rescue (ADR-0051 extension):
   * the second RDAP leg could not answer and WHOIS confirmed Available for
   * a TLD in the forced-rescue list. Present only when > 0.
   */
  perTldRescued?: number;
  /**
   * Verdicts skipped because the second leg's origin was authoritative for
   * the candidate's TLD — the 2-of-2 would have been a rubber stamp
   * (ADR-0058). Present only when > 0.
   */
  originOverlap?: number;
  /**
   * Verdicts downgraded because the per-TLD authoritative-origin resolver
   * failed (ADR-0060): the guard could not rule out that the second leg is
   * an authoritative origin for the TLD, so the second opinion is never
   * consulted — fail-closed, the verdict stays unverifiable. Present only
   * when > 0.
   */
  originGuardUnavailable?: number;
  /**
   * Available verdicts the tertiary leg rescued: the secondary could not
   * answer and the tertiary confirmed Available. Present only when > 0.
   */
  tertiaryRescued?: number;
  /**
   * Definitive disagreements from the tertiary leg (tertiary says Registered)
   * — valid answers that veto the domain. Present only when > 0.
   */
  tertiaryDisagreed?: number;
  /**
   * Verdicts skipped because the tertiary leg's origin was authoritative for
   * the candidate's TLD or matched the winning primary/secondary origin —
   * the tertiary would have been a rubber stamp. Present only when > 0.
   */
  tertiaryOriginOverlap?: number;
  /**
   * Verdicts downgraded because the per-TLD authoritative-origin resolver
   * failed for the tertiary leg — the guard could not rule out that the
   * tertiary leg is an authoritative origin for the TLD. Present only when > 0.
   */
  tertiaryOriginGuardUnavailable?: number;
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
