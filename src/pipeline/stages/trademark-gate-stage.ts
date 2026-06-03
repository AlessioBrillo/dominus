import { CandidateStatus } from '../../types/candidate.js';
import { ProviderError } from '../../types/errors.js';
import type { DomainCandidate } from '../../types/candidate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { Stage, StageResult } from '../stage.js';

export class TrademarkGateStage implements Stage<DomainCandidate> {
  readonly name = 'TrademarkGateStage';

  constructor(private readonly gate: TrademarkGate) {}

  async process(candidates: DomainCandidate[]): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const passed: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];

    for (const candidate of candidates) {
      try {
        const result = await this.gate.check(candidate.domain);
        if (result.verdict === GateVerdict.Blocked) {
          filtered.push({ ...candidate, status: CandidateStatus.TrademarkBlocked });
        } else {
          passed.push(candidate);
        }
      } catch (err: unknown) {
        if (err instanceof ProviderError) {
          passed.push({ ...candidate, status: CandidateStatus.Unscored });
        } else {
          filtered.push({ ...candidate, status: CandidateStatus.TrademarkBlocked });
        }
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
