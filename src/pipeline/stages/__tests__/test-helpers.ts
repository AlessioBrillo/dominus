import {
  CandidateSource,
  CandidateStatus,
  type DomainCandidate,
} from '../../../types/candidate.js';

export function createMockCandidate(
  overrides: { domain: string } & Partial<DomainCandidate>,
): DomainCandidate {
  const defaults = {
    source: CandidateSource.KeywordCombo,
    pipelineRunId: 'test-run',
    tld: overrides.domain.split('.').slice(-1)[0] ?? '',
    status: CandidateStatus.Pending,
    isPremium: false,
  };
  return { ...defaults, ...overrides } as DomainCandidate;
}
