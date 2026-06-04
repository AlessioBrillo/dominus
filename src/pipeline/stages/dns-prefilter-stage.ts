import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import type { Stage, StageResult } from '../stage.js';

export class DnsPreFilterStage implements Stage<DomainCandidate> {
  readonly name = 'DnsPreFilterStage';

  constructor(private readonly dnsProvider: DnsProvider) {}

  async process(candidates: DomainCandidate[]): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const results = await this.dnsProvider.checkBulk(candidates.map((c) => c.domain));

    const passed: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const result = results[i];
      if (candidate === undefined || result === undefined) continue;

      if (result.status === DomainStatus.Available || result.status === DomainStatus.Unknown) {
        passed.push({ ...candidate, dnsStatus: result.status, status: CandidateStatus.Pending });
      } else {
        filtered.push({ ...candidate, dnsStatus: result.status, status: CandidateStatus.DnsFiltered });
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
