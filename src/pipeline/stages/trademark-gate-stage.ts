import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { Stage, StageResult } from '../stage.js';

/**
 * Principle 6 enforcement: no candidate reaches `recommended` without a
 * confirmed trademark clearance. A provider error counts as "cannot clear" —
 * the candidate is routed to `filtered` with status `Unscored`, never surfaced
 * as a buy recommendation.
 *
 * Generic over T extends DomainCandidate so that ScoredCandidate (which carries
 * `scoreResult`) passes through the gate unmodified except for `status`.
 */
export class TrademarkGateStage<T extends DomainCandidate> implements Stage<T> {
  readonly name = 'TrademarkGateStage';

  constructor(private readonly gate: TrademarkGate) {}

  async process(candidates: T[]): Promise<StageResult<T>> {
    const start = Date.now();
    const passed: T[] = [];
    const filtered: T[] = [];

    for (const candidate of candidates) {
      try {
        const result = await this.gate.check(candidate.domain);
        if (result.verdict === GateVerdict.Blocked) {
          // Confirmed trademark match — never recommend (Principle 6).
          filtered.push({ ...candidate, status: CandidateStatus.TrademarkBlocked });
        } else if (result.verdict === GateVerdict.Unverified) {
          // All trademark sources failed — cannot confirm clearance (Principle 6).
          // Do NOT recommend even though no explicit match was found.
          filtered.push({ ...candidate, status: CandidateStatus.Unscored });
        } else {
          // GateVerdict.Clear (possibly partial) — trademark clearance confirmed.
          passed.push(candidate);
        }
      } catch {
        // Unexpected error from gate.check() itself → conservative filter.
        filtered.push({ ...candidate, status: CandidateStatus.Unscored });
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
