// SPDX-License-Identifier: AGPL-3.0-only
import { CandidateStatus } from '../../types/candidate.js';
import { toBatches } from '../../utils/array.js';
import type { DomainCandidate } from '../../types/candidate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { Stage, StageDegradation, StageResult } from '../stage.js';

export class TrademarkGateStage<T extends DomainCandidate> implements Stage<T> {
  readonly name = 'TrademarkGateStage';

  constructor(
    private readonly gate: TrademarkGate,
    private readonly concurrency: number = 5,
  ) {}

  async process(candidates: T[], signal?: AbortSignal): Promise<StageResult<T>> {
    const start = Date.now();
    if (signal?.aborted) return { passed: [], filtered: [], stageName: this.name, durationMs: 0 };
    const passed: T[] = [];
    const filtered: T[] = [];
    let pending = 0;

    const batches = toBatches(candidates, this.concurrency);
    for (const batch of batches) {
      if (signal?.aborted) break;
      const tasks = batch.map(async (candidate) => {
        const result = await this.gate.check(candidate.domain, signal);
        return { candidate, verdict: result.verdict };
      });

      const settled = await Promise.allSettled(tasks);

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!;
        const candidate = batch[i]!;

        if (result.status === 'fulfilled') {
          const { verdict } = result.value;
          if (verdict === GateVerdict.Blocked) {
            filtered.push({ ...candidate, status: CandidateStatus.TrademarkBlocked });
          } else if (verdict === GateVerdict.Unverified) {
            // No answer is not "clear" (ADR-0097). Keep the candidate out of
            // `passed`, but mark it as retryable rather than unscored: the
            // trademark evidence is missing, not the commercial evidence.
            pending++;
            filtered.push({ ...candidate, status: CandidateStatus.TrademarkPending });
          } else {
            passed.push(candidate);
          }
        } else {
          // A thrown check is an unreachable source, not a negative verdict.
          pending++;
          filtered.push({ ...candidate, status: CandidateStatus.TrademarkPending });
        }
      }
    }

    const degradations: StageDegradation[] = [];
    if (pending > 0) {
      // ADR-0037: report partial upstream output on the run's degradation
      // channel instead of failing the run or silently losing the signal.
      degradations.push({
        stageName: this.name,
        reason: 'trademark-source-unavailable',
        processedCount: candidates.length - pending,
        expectedCount: candidates.length,
        message: `${pending} candidate(s) held without a trademark verdict`,
      });
    }

    return {
      passed,
      filtered,
      stageName: this.name,
      durationMs: Date.now() - start,
      degradations,
    };
  }
}
