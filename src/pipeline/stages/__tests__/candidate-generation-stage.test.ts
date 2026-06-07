import { describe, it, expect } from 'vitest';
import { CandidateGenerationStage } from '../candidate-generation-stage.js';
import { CandidateSource } from '../../../types/candidate.js';

describe('CandidateGenerationStage — multi-part TLD extraction (ADR-0013)', () => {
  const stage = new CandidateGenerationStage();

  it('extracts the multi-part TLD for brandable ccTLD candidates', async () => {
    const result = await stage.process([
      { brandableNames: ['nike.co.uk', 'foo.com.au', 'a.ne.jp'] },
    ]);
    const byDomain = new Map(result.passed.map((c) => [c.domain, c]));
    expect(byDomain.get('nike.co.uk')?.tld).toBe('.co.uk');
    expect(byDomain.get('foo.com.au')?.tld).toBe('.com.au');
    expect(byDomain.get('a.ne.jp')?.tld).toBe('.ne.jp');
  });

  it('still extracts the single-part TLD for vanilla gTLDs', async () => {
    const result = await stage.process([{ brandableNames: ['nike.com', 'foo.io'] }]);
    const byDomain = new Map(result.passed.map((c) => [c.domain, c]));
    expect(byDomain.get('nike.com')?.tld).toBe('.com');
    expect(byDomain.get('foo.io')?.tld).toBe('.io');
  });

  it('extracts the multi-part TLD for closeout candidates', async () => {
    const result = await stage.process([{ closeoutDomains: ['nike.co.uk', 'foo.com.au'] }]);
    const byDomain = new Map(result.passed.map((c) => [c.domain, c]));
    expect(byDomain.get('nike.co.uk')?.tld).toBe('.co.uk');
    expect(byDomain.get('foo.com.au')?.tld).toBe('.com.au');
    for (const c of result.passed) {
      expect(c.source).toBe(CandidateSource.CloseoutCsv);
    }
  });

  it('extracts the multi-part TLD for closeout entries with metadata', async () => {
    const result = await stage.process([
      {
        closeoutEntries: [
          { domain: 'nike.co.uk', domainAge: 12, backlinks: 50 },
          { domain: 'foo.com.au', waybackSnapshots: 200 },
        ],
      },
    ]);
    const byDomain = new Map(result.passed.map((c) => [c.domain, c]));
    expect(byDomain.get('nike.co.uk')?.tld).toBe('.co.uk');
    expect(byDomain.get('nike.co.uk')?.closeoutMeta?.domainAge).toBe(12);
    expect(byDomain.get('foo.com.au')?.tld).toBe('.com.au');
    expect(byDomain.get('foo.com.au')?.closeoutMeta?.waybackSnapshots).toBe(200);
  });
});
