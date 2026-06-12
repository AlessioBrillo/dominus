import { CandidateStatus, CandidateSource } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { ScoreResult } from '../../types/score.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import { parseDomain } from '../../utils/domain.js';
import type { Stage, StageResult } from '../stage.js';

export interface ScoredCandidate extends DomainCandidate {
  scoreResult: ScoreResult | null;
}

export class ScoringStage implements Stage<DomainCandidate, ScoredCandidate> {
  readonly name = 'ScoringStage';

  constructor(private readonly engine: ScoringEngine) {}

  async process(
    candidates: DomainCandidate[],
    _signal?: AbortSignal,
  ): Promise<StageResult<ScoredCandidate>> {
    const start = Date.now();
    const passed: ScoredCandidate[] = [];
    const filtered: ScoredCandidate[] = [];

    for (const candidate of candidates) {
      try {
        const scoreResult = await this.engine.score({
          domain: candidate.domain,
          tld: candidate.tld,
          // Canonical SLD via the shared parser (see ADR-0013). For a
          // multi-part TLD like .co.uk, the naive `domain.replace(tld)`
          // approach would leave 'co' in the SLD; parseDomain returns
          // just the label the operator cares about.
          sld: parseDomain(candidate.domain).sld,
          isCloseout: candidate.source === CandidateSource.CloseoutCsv,
          // Closeout metadata (when imported) feeds the expiry signal; absent for
          // keyword/brandable candidates, where the signal stays zero.
          domainAge: candidate.closeoutMeta?.domainAge,
          backlinks: candidate.closeoutMeta?.backlinks,
          waybackSnapshots: candidate.closeoutMeta?.waybackSnapshots,
        });

        const status = scoreResult.recommended
          ? CandidateStatus.Recommended
          : CandidateStatus.Scored;
        const scored: ScoredCandidate = { ...candidate, status, scoreResult };

        if (scoreResult.recommended) {
          passed.push(scored);
        } else {
          filtered.push(scored);
        }
      } catch {
        filtered.push({ ...candidate, status: CandidateStatus.Unscored, scoreResult: null });
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
