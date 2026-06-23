import { CandidateStatus, CandidateSource } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { ScoreResult } from '../../types/score.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { Stage, StageResult } from '../stage.js';

export interface ScoredCandidate extends DomainCandidate {
  scoreResult: ScoreResult | null;
}

function toBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export class ScoringStage implements Stage<DomainCandidate, ScoredCandidate> {
  readonly name = 'ScoringStage';

  constructor(
    private readonly engine: ScoringEngine,
    private readonly concurrency: number = 5,
  ) {}

  async process(
    candidates: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<StageResult<ScoredCandidate>> {
    const start = Date.now();
    if (signal?.aborted) return { passed: [], filtered: [], stageName: this.name, durationMs: 0 };

    const passed: ScoredCandidate[] = [];
    const filtered: ScoredCandidate[] = [];

    const batches = toBatches(candidates, this.concurrency);
    for (const batch of batches) {
      if (signal?.aborted) break;

      const results = await Promise.allSettled(
        batch.map(async (candidate) => {
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

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
