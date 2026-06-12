import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { Stage, StageResult } from '../stage.js';

function toBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export class TrademarkGateStage<T extends DomainCandidate> implements Stage<T> {
  readonly name = 'TrademarkGateStage';

  constructor(
    private readonly gate: TrademarkGate,
    private readonly concurrency: number = 3,
  ) {}

  async process(candidates: T[], _signal?: AbortSignal): Promise<StageResult<T>> {
    const start = Date.now();
    const passed: T[] = [];
    const filtered: T[] = [];

    const batches = toBatches(candidates, this.concurrency);
    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async (candidate) => {
          const result = await this.gate.check(candidate.domain);
          return { candidate, verdict: result.verdict };
        }),
      );

      for (const settled of results) {
        if (settled.status === 'fulfilled') {
          const { candidate, verdict } = settled.value;
          if (verdict === GateVerdict.Blocked) {
            filtered.push({ ...candidate, status: CandidateStatus.TrademarkBlocked });
          } else if (verdict === GateVerdict.Unverified) {
            filtered.push({ ...candidate, status: CandidateStatus.Unscored });
          } else {
            passed.push(candidate);
          }
        } else {
          const idx = results.indexOf(settled);
          const failed = batch[idx];
          if (failed) {
            filtered.push({ ...failed, status: CandidateStatus.Unscored });
          }
        }
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
