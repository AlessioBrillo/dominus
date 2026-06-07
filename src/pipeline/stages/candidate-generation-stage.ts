import { randomUUID } from 'node:crypto';
import { CandidateSource, CandidateStatus } from '../../types/candidate.js';
import type { CloseoutEntry, DomainCandidate } from '../../types/candidate.js';
import type { Stage, StageResult } from '../stage.js';
import { extractTld } from '../../utils/domain.js';

export interface CandidateGenerationInput {
  keywords?: string[] | undefined;
  brandableNames?: string[] | undefined;
  /** Plain closeout domains with no metadata (e.g. the inline --closeout flag). */
  closeoutDomains?: string[] | undefined;
  /** Closeout domains carrying expiry-signal metadata (e.g. a --closeout-csv import). */
  closeoutEntries?: CloseoutEntry[] | undefined;
}

export class CandidateGenerationStage implements Stage<CandidateGenerationInput, DomainCandidate> {
  readonly name = 'CandidateGenerationStage';

  process(inputs: CandidateGenerationInput[]): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const passed: DomainCandidate[] = [];
    const runId = randomUUID();

    for (const input of inputs) {
      for (const domain of input.keywords ?? []) {
        const tld = '.com';
        passed.push({ domain: `${domain}${tld}`, tld, source: CandidateSource.KeywordCombo, status: CandidateStatus.Pending, isPremium: false, pipelineRunId: runId });
      }
      for (const domain of input.brandableNames ?? []) {
        const tld = extractTld(domain);
        passed.push({ domain, tld, source: CandidateSource.Brandable, status: CandidateStatus.Pending, isPremium: false, pipelineRunId: runId });
      }
      for (const domain of input.closeoutDomains ?? []) {
        const tld = extractTld(domain);
        passed.push({ domain, tld, source: CandidateSource.CloseoutCsv, status: CandidateStatus.Pending, isPremium: false, pipelineRunId: runId });
      }
      for (const entry of input.closeoutEntries ?? []) {
        const tld = extractTld(entry.domain);
        passed.push({
          domain: entry.domain,
          tld,
          source: CandidateSource.CloseoutCsv,
          status: CandidateStatus.Pending,
          isPremium: false,
          pipelineRunId: runId,
          closeoutMeta: { domainAge: entry.domainAge, backlinks: entry.backlinks, waybackSnapshots: entry.waybackSnapshots },
        });
      }
    }

    const seen = new Set<string>();
    const deduped = passed.filter((c) => {
      if (seen.has(c.domain)) return false;
      seen.add(c.domain);
      return true;
    });

    return Promise.resolve({ passed: deduped, filtered: [], stageName: this.name, durationMs: Date.now() - start });
  }
}
