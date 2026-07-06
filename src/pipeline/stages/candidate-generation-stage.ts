import { randomUUID } from 'node:crypto';
import { CandidateSource, CandidateStatus } from '../../types/candidate.js';
import type { CloseoutEntry, DomainCandidate } from '../../types/candidate.js';
import type { Stage, StageResult } from '../stage.js';
import { extractTld } from '../../utils/domain.js';
import { normalizeDomain } from '../../utils/domain-validator.js';

export interface CandidateGenerationInput {
  keywords?: string[] | undefined;
  brandableNames?: string[] | undefined;
  /** Plain closeout domains with no metadata (e.g. the inline --closeout flag). */
  closeoutDomains?: string[] | undefined;
  /** Closeout domains carrying expiry-signal metadata (e.g. a --closeout-csv import). */
  closeoutEntries?: CloseoutEntry[] | undefined;
  /**
   * Direct domain injection — bypasses keyword/brandable/closeout processing.
   * These domains are passed through DNS pre-filter and the rest of the pipeline
   * as-is. Useful for rescore operations and incremental checks.
   */
  domains?: string[] | undefined;
  /**
   * Optional external run ID. When provided, all generated candidates use this
   * as their pipelineRunId instead of generating a new UUID. This eliminates
   * the need for a post-generation UPDATE to sync run IDs (previously done in
   * PipelineRunService).
   */
  externalRunId?: string | undefined;
}

export class CandidateGenerationStage implements Stage<CandidateGenerationInput, DomainCandidate> {
  readonly name = 'CandidateGenerationStage';

  constructor(private readonly defaultKeywordTld: string = '.com') {}

  process(
    inputs: CandidateGenerationInput[],
    _signal?: AbortSignal,
    externalRunId?: string,
  ): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const passed: DomainCandidate[] = [];
    const runId = externalRunId ?? inputs[0]?.externalRunId ?? randomUUID();

    for (const input of inputs) {
      for (const domain of input.keywords ?? []) {
        const tld = this.defaultKeywordTld;
        passed.push({
          domain: `${domain}${tld}`,
          tld,
          source: CandidateSource.KeywordCombo,
          status: CandidateStatus.Pending,
          isPremium: false,
          pipelineRunId: runId,
        });
      }
      for (const domain of input.brandableNames ?? []) {
        const tld = extractTld(domain);
        passed.push({
          domain,
          tld,
          source: CandidateSource.Brandable,
          status: CandidateStatus.Pending,
          isPremium: false,
          pipelineRunId: runId,
        });
      }
      for (const domain of input.closeoutDomains ?? []) {
        const tld = extractTld(domain);
        passed.push({
          domain,
          tld,
          source: CandidateSource.CloseoutCsv,
          status: CandidateStatus.Pending,
          isPremium: false,
          pipelineRunId: runId,
        });
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
          closeoutMeta: {
            domainAge: entry.domainAge,
            backlinks: entry.backlinks,
            waybackSnapshots: entry.waybackSnapshots,
          },
        });
      }
      for (const domain of input.domains ?? []) {
        const tld = extractTld(domain);
        passed.push({
          domain,
          tld,
          source: CandidateSource.KeywordCombo,
          status: CandidateStatus.Pending,
          isPremium: false,
          pipelineRunId: runId,
        });
      }
    }

    const seen = new Set<string>();
    const deduped = passed.filter((c) => {
      if (seen.has(c.domain)) return false;
      seen.add(c.domain);
      return true;
    });

    const validated: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];
    for (const c of deduped) {
      const norm = normalizeDomain(c.domain);
      if (!norm.isValid) {
        filtered.push({ ...c, status: CandidateStatus.Unscored });
        continue;
      }
      validated.push({ ...c, normalizedDomain: norm, tld: norm.tld, domain: norm.normalized });
    }

    return Promise.resolve({
      passed: validated,
      filtered,
      stageName: this.name,
      durationMs: Date.now() - start,
    });
  }
}
