import { CandidateStatus, CandidateSource } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { ScoreResult } from '../../types/score.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { Stage, StageResult } from '../stage.js';

export interface ScoredCandidate extends DomainCandidate {
  scoreResult: ScoreResult;
}

export class ScoringStage implements Stage<DomainCandidate, ScoredCandidate> {
  readonly name = 'ScoringStage';

  constructor(private readonly engine: ScoringEngine) {}

  async process(candidates: DomainCandidate[]): Promise<StageResult<ScoredCandidate>> {
    const start = Date.now();
    const passed: ScoredCandidate[] = [];
    const filtered: ScoredCandidate[] = [];

    for (const candidate of candidates) {
      try {
        const scoreResult = await this.engine.score({
          domain: candidate.domain,
          tld: candidate.tld,
          isCloseout: candidate.source === CandidateSource.CloseoutCsv,
        });

        const status = scoreResult.recommended ? CandidateStatus.Recommended : CandidateStatus.Scored;
        const scored: ScoredCandidate = { ...candidate, status, scoreResult };

        if (scoreResult.recommended) {
          passed.push(scored);
        } else {
          filtered.push(scored);
        }
      } catch {
        filtered.push({ ...candidate, status: CandidateStatus.Unscored, scoreResult: null as unknown as ScoreResult });
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
