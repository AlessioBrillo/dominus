// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { CandidateSource, CandidateStatus } from '../../types/candidate.js';
import type { CloseoutEntry, DomainCandidate } from '../../types/candidate.js';
import type { Stage, StageResult } from '../stage.js';
import { extractTld, normalizeDomain } from '../../utils/domain.js';

const CONSONANTS = 'bcdfghjklmnpqrstvwxyz';
const VOWELS = 'aeiou';
const RANDOM_PREFIXES = ['e', 'i', 'my', 'get', 'try', 'go', 'best', 'top', 'my', 'the'];
const RANDOM_SUFFIXES = ['hub', 'lab', 'io', 'ly', 'ify', 'base', 'spot', 'zone', 'net', 'pro'];

export function generateRandomSld(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    const pool = i % 2 === 0 ? CONSONANTS : VOWELS;
    result += pool.charAt(Math.floor(Math.random() * pool.length));
  }
  return result;
}

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
   * Sector-based generation: keywords from a sector keyword pack (see
   * examples/sector-keywords.json). Each keyword is combined with the default
   * TLD unless it already contains a dot.
   */
  sectorKeywords?: string[] | undefined;
  /**
   * Random domain generation: generates `randomCount` brandable-style names
   * of random length (5-10 chars) with the default TLD. Useful for
   * "sorprendimi" discovery.
   */
  randomCount?: number | undefined;
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
      for (const keyword of input.sectorKeywords ?? []) {
        const tld = keyword.includes('.') ? extractTld(keyword) : this.defaultKeywordTld;
        const name = keyword.includes('.') ? keyword.replace(/\.[^.]+$/, '') : keyword;
        passed.push({
          domain: `${name}${tld}`,
          tld,
          source: CandidateSource.Sector,
          status: CandidateStatus.Pending,
          isPremium: false,
          pipelineRunId: runId,
        });
      }
      for (let i = 0; i < (input.randomCount ?? 0); i++) {
        const length = 5 + Math.floor(Math.random() * 6); // 5-10 chars
        const sld = generateRandomSld(length);
        const prefix =
          Math.random() < 0.5
            ? ''
            : RANDOM_PREFIXES[Math.floor(Math.random() * RANDOM_PREFIXES.length)];
        const suffix =
          Math.random() < 0.5
            ? ''
            : RANDOM_SUFFIXES[Math.floor(Math.random() * RANDOM_SUFFIXES.length)];
        const domain = `${prefix}${sld}${suffix}${this.defaultKeywordTld}`;
        passed.push({
          domain,
          tld: this.defaultKeywordTld,
          source: CandidateSource.Random,
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
