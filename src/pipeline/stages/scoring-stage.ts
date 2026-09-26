// SPDX-License-Identifier: AGPL-3.0-only
import { CandidateStatus, CandidateSource } from '../../types/candidate.js';
import { toBatches } from '../../utils/array.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { ScoreResult } from '../../types/score.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { WaybackProvider } from '../../providers/wayback/wayback-provider.js';
import type { Stage, StageResult } from '../stage.js';

export interface ScoredCandidate extends DomainCandidate {
  scoreResult: ScoreResult | null;
}

export class ScoringStage implements Stage<DomainCandidate, ScoredCandidate> {
  readonly name = 'ScoringStage';

  constructor(
    private readonly engine: ScoringEngine,
    private readonly concurrency: number = 10,
    private readonly waybackProvider?: WaybackProvider,
  ) {}

  async process(
    candidates: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<StageResult<ScoredCandidate>> {
    const start = Date.now();
    if (signal?.aborted) return { passed: [], filtered: [], stageName: this.name, durationMs: 0 };

    const passed: ScoredCandidate[] = [];
    const filtered: ScoredCandidate[] = [];
    let commercialUnavailableCount = 0;
    let totalScored = 0;

    const batches = toBatches(candidates, this.concurrency);
    for (const batch of batches) {
      if (signal?.aborted) break;

      const enriched = await this.#enrichWithWayback(batch, signal);

      const results = await Promise.allSettled(
        enriched.map(async (candidate) => {
          try {
            const scoreResult = await this.engine.score(
              {
                domain: candidate.domain,
                isCloseout: candidate.source === CandidateSource.CloseoutCsv,
                domainAge: candidate.closeoutMeta?.domainAge ?? candidate.whoisMeta?.domainAge,
                backlinks: candidate.closeoutMeta?.backlinks,
                waybackSnapshots: candidate.closeoutMeta?.waybackSnapshots,
                registrar: candidate.whoisMeta?.registrar,
              },
              signal,
            );

            const status = scoreResult.recommended
              ? CandidateStatus.Recommended
              : CandidateStatus.Scored;

            // Track commercial signal availability for degradation detection
            if (scoreResult !== null) {
              totalScored++;
              const commercialSignal = scoreResult.signalStatus.find(
                (s) => s.name === 'commercial',
              );
              if (commercialSignal && commercialSignal.available === false) {
                commercialUnavailableCount++;
              }
            }

            return { candidate, status, scoreResult } as const;
          } catch {
            return { candidate, status: CandidateStatus.Unscored, scoreResult: null } as const;
          }
        }),
      );

      for (const settled of results) {
        if (settled.status === 'rejected') continue;
        const { candidate, status, scoreResult } = settled.value;
        const scored: ScoredCandidate = { ...candidate, status, scoreResult };

        if (scoreResult !== null && scoreResult.recommended) {
          passed.push(scored);
        } else {
          filtered.push(scored);
        }
      }
    }

    // Emit degradation if commercial signal unavailable for >50% of scored candidates
    const degradations = [];
    if (totalScored > 0 && commercialUnavailableCount / totalScored > 0.5) {
      degradations.push({
        stageName: this.name,
        reason: 'commercial-signal-unavailable' as const,
        processedCount: totalScored - commercialUnavailableCount,
        expectedCount: totalScored,
        message: `${commercialUnavailableCount}/${totalScored} candidates scored without commercial signal data — falling back to intrinsic-only scoring`,
      });
    }

    return {
      passed,
      filtered,
      stageName: this.name,
      durationMs: Date.now() - start,
      ...(degradations.length > 0 ? { degradations } : {}),
    };
  }

  /**
   * Enrich candidates with Wayback Machine expiry data when the candidate
   * does not already carry closeout metadata. Non-fatal — candidates
   * without wayback data proceed with degraded expiry signal.
   * Extracted from ScoringEngine to respect Principle 1 (provider
   * abstraction: the pipeline stage owns enrichment, not the pure engine).
   */
  async #enrichWithWayback(
    candidates: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<DomainCandidate[]> {
    const wp = this.waybackProvider;
    if (!wp) return candidates;

    const enriched = await Promise.allSettled(
      candidates.map(async (candidate) => {
        if (signal?.aborted) return candidate;

        const hasExpiryData =
          candidate.closeoutMeta?.domainAge !== undefined ||
          candidate.closeoutMeta?.backlinks !== undefined ||
          candidate.closeoutMeta?.waybackSnapshots !== undefined ||
          candidate.whoisMeta?.domainAge !== undefined;

        if (hasExpiryData) return candidate;

        try {
          const wayback = await wp.getExpiryData(candidate.domain, signal);
          if (wayback.domainAge > 0 || wayback.waybackSnapshots > 0) {
            return {
              ...candidate,
              closeoutMeta: {
                ...candidate.closeoutMeta,
                domainAge: wayback.domainAge,
                waybackSnapshots: wayback.waybackSnapshots,
              },
            };
          }
        } catch {
          // Non-fatal — expiry signal degrades gracefully
        }
        return candidate;
      }),
    );

    return enriched.map((r, i) => (r.status === 'fulfilled' ? r.value : candidates[i]!));
  }
}
