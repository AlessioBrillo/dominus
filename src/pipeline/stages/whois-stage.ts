import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate, WhoisMeta } from '../../types/candidate.js';
import type { WhoisProvider } from '../../providers/whois/whois-provider.js';
import type { Stage, StageResult } from '../stage.js';

export class WhoisStage implements Stage<DomainCandidate> {
  readonly name = 'WhoisStage';

  constructor(
    private readonly whoisProvider: WhoisProvider,
    private readonly concurrency: number = 3,
  ) {}

  async process(
    candidates: DomainCandidate[],
    _signal?: AbortSignal,
  ): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const enriched: DomainCandidate[] = [];

    const batches = this.#toBatches(candidates, this.concurrency);
    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async (candidate) => {
          const whoisMeta = await this.#enrich(candidate);
          return { candidate, whoisMeta };
        }),
      );
      for (const settled of results) {
        if (settled.status === 'fulfilled') {
          enriched.push({ ...settled.value.candidate, whoisMeta: settled.value.whoisMeta });
        } else {
          const failed =
            batch[
              candidates.indexOf(
                (settled.reason as { candidate?: DomainCandidate })?.candidate ?? batch[0]!,
              )
            ]!;
          enriched.push({ ...failed, status: CandidateStatus.Unscored });
        }
      }
    }

    return {
      passed: enriched,
      filtered: [],
      stageName: this.name,
      durationMs: Date.now() - start,
    };
  }

  async #enrich(candidate: DomainCandidate): Promise<WhoisMeta | undefined> {
    if (candidate.closeoutMeta?.domainAge !== undefined) {
      return undefined;
    }
    try {
      const result = await this.whoisProvider.checkAvailability(candidate.domain);
      const meta: WhoisMeta = {};
      if (result.createdDate !== undefined) {
        const created = new Date(result.createdDate);
        meta.createdDate = result.createdDate;
        meta.domainAge = Math.max(
          0,
          (Date.now() - created.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
        );
      }
      if (result.registrar !== undefined) {
        meta.registrar = result.registrar;
      }
      if (result.expiryDate !== undefined) {
        meta.expiryDate = result.expiryDate;
      }
      return Object.keys(meta).length > 0 ? meta : undefined;
    } catch {
      return undefined;
    }
  }

  #toBatches<T>(items: T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      batches.push(items.slice(i, i + size));
    }
    return batches;
  }
}
