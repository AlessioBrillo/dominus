import { describe, it, expect } from 'vitest';
import { parseCloseoutCsv, isValidDomain } from '../closeout-csv.js';

describe('isValidDomain', () => {
  it('accepts a normal multi-label domain', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('my-site.co.uk')).toBe(true);
  });

  it('rejects names without a TLD, with spaces, or with bad characters', () => {
    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('bad domain.com')).toBe(false);
    expect(isValidDomain('-leading.com')).toBe(false);
    expect(isValidDomain('')).toBe(false);
  });
});

describe('parseCloseoutCsv', () => {
  it('parses a full row into domain + metadata', () => {
    const csv = 'domain,age,backlinks,wayback\nexpired.com,12,340,87\n';
    expect(parseCloseoutCsv(csv)).toEqual([
      { domain: 'expired.com', domainAge: 12, backlinks: 340, waybackSnapshots: 87 },
    ]);
  });

  it('leaves omitted optional columns undefined', () => {
    const csv = 'domain\nlonely.com\n';
    expect(parseCloseoutCsv(csv)).toEqual([
      {
        domain: 'lonely.com',
        domainAge: undefined,
        backlinks: undefined,
        waybackSnapshots: undefined,
      },
    ]);
  });

  it('honours arbitrary column order via the header', () => {
    const csv = 'backlinks,domain,wayback,age\n50,reordered.com,9,3\n';
    expect(parseCloseoutCsv(csv)).toEqual([
      { domain: 'reordered.com', domainAge: 3, backlinks: 50, waybackSnapshots: 9 },
    ]);
  });

  it('skips rows whose domain is missing or invalid', () => {
    const csv = 'domain,age\n,5\nnot a domain,5\nvalid.com,5\n';
    expect(parseCloseoutCsv(csv)).toEqual([
      { domain: 'valid.com', domainAge: 5, backlinks: undefined, waybackSnapshots: undefined },
    ]);
  });

  it('ignores blank lines and # comments', () => {
    const csv = '# closeout export\ndomain,age\n\ngood.com,4\n\n# trailing note\n';
    expect(parseCloseoutCsv(csv)).toEqual([
      { domain: 'good.com', domainAge: 4, backlinks: undefined, waybackSnapshots: undefined },
    ]);
  });

  it('coerces malformed or negative numerics to undefined', () => {
    const csv = 'domain,age,backlinks\nbad-nums.com,abc,-5\n';
    expect(parseCloseoutCsv(csv)).toEqual([
      {
        domain: 'bad-nums.com',
        domainAge: undefined,
        backlinks: undefined,
        waybackSnapshots: undefined,
      },
    ]);
  });

  it('lowercases the domain and ignores unknown columns', () => {
    const csv = 'domain,traffic,age\nMixedCase.COM,9000,7\n';
    expect(parseCloseoutCsv(csv)).toEqual([
      { domain: 'mixedcase.com', domainAge: 7, backlinks: undefined, waybackSnapshots: undefined },
    ]);
  });

  it('returns empty when there is no domain column or no data rows', () => {
    expect(parseCloseoutCsv('age,backlinks\n12,5\n')).toEqual([]);
    expect(parseCloseoutCsv('domain,age\n')).toEqual([]);
    expect(parseCloseoutCsv('')).toEqual([]);
  });
});
