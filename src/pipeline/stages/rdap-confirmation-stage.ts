import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { Stage, StageResult } from '../stage.js';

export class RdapConfirmationStage implements Stage<DomainCandidate> {
  readonly name = 'RdapConfirmationStage';

  constructor(private readonly rdapProvider: RdapProvider) {}

  async process(candidates: DomainCandidate[]): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const passed: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];

    for (const candidate of candidates) {
      try {
        const result = await this.rdapProvider.confirm(candidate.domain);
        if (result.status === DomainStatus.Available && !result.isPremium) {
          passed.push({ ...candidate, rdapStatus: result.status, isPremium: false, status: CandidateStatus.Pending });
        } else {
          filtered.push({
            ...candidate,
            rdapStatus: result.status,
            isPremium: result.isPremium,
            status: CandidateStatus.RdapFiltered,
          });
        }
      } catch {
        filtered.push({ ...candidate, rdapStatus: 'error', status: CandidateStatus.RdapFiltered });
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }
}
