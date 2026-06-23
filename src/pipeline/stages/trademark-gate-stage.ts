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

  async process(candidates: T[], signal?: AbortSignal): Promise<StageResult<T>> {
    const start = Date.now();
    if (signal?.aborted) return { passed: [], filtered: [], stageName: this.name, durationMs: 0 };
    const passed: T[] = [];
    const filtered: T[] = [];

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
            filtered.push({ ...candidate, status: CandidateStatus.Unscored });
          } else {
            passed.push(candidate);
          }
        } else {
          filtered.push({ ...candidate, status: CandidateStatus.Unscored });
        }
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
