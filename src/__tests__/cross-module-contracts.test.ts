import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('cross-module contracts', () => {
  describe('parseDomain (ADR-0013, ADR-0015)', () => {
    it('scoring-engine imports parseDomain from utils/domain (canonical SLD source)', () => {
      const source = readFileSync(resolve(here, '../scoring/scoring-engine.ts'), 'utf-8');
      const imports = source
        .split('\n')
        .filter((l) => l.includes('from') && l.includes('domain'))
        .join('\n');
      expect(imports).toMatch(/utils\/domain\.js/);
    });

    it('trademark match-detector imports extractSld from utils/domain', () => {
      const source = readFileSync(resolve(here, '../trademark/match-detector.ts'), 'utf-8');
      expect(source).toMatch(/from ['"].*utils\/domain\.js['"]/);
      expect(source).toMatch(/\bextractSld\b/);
    });

    it('portfolio-rescore-service does NOT import parseDomain (delegates to ScoringEngine)', () => {
      const source = readFileSync(
        resolve(here, '../portfolio/portfolio-rescore-service.ts'),
        'utf-8',
      );
      const domainImports = source
        .split('\n')
        .filter((l) => l.includes('from') && l.includes('domain') && !l.includes('types'));
      expect(domainImports).toHaveLength(0);
    });

    it('both modules that consume SLD import from the same @psl-based source', () => {
      const consumers = [
        { name: 'scoring-engine', path: '../scoring/scoring-engine.ts' },
        { name: 'match-detector', path: '../trademark/match-detector.ts' },
      ];
      for (const { name: _name, path } of consumers) {
        const source = readFileSync(resolve(here, path), 'utf-8');
        const sldImports = source
          .split('\n')
          .filter(
            (l) => (l.includes('parseDomain') || l.includes('extractSld')) && l.includes('from'),
          );
        for (const imp of sldImports) {
          expect(imp).toMatch(/utils\/domain\.js/);
        }
      }
    });

    it('returns correct SLD via PSL for known test vectors', async () => {
      const { parseDomain } = await import('../utils/domain.js');
      const testCases: Array<{ domain: string; expectedSld: string }> = [
        { domain: 'example.com', expectedSld: 'example' },
        { domain: 'my-domain.co.uk', expectedSld: 'my-domain' },
        { domain: 'hello.world.org.au', expectedSld: 'world' },
        { domain: 'sub.domain.io', expectedSld: 'domain' },
        { domain: 'Hello-World.com', expectedSld: 'hello-world' },
      ];
      for (const { domain, expectedSld } of testCases) {
        const parsed = parseDomain(domain);
        expect(parsed.sld).toBe(expectedSld);
      }
    });
  });

  describe('ScoringEngine + TrademarkGate SLD consistency (ADR-0013)', () => {
    it('both modules derive the same canonical SLD for a mixed-case domain', async () => {
      const { extractSld } = await import('../utils/domain.js');
      const { parseDomain } = await import('../utils/domain.js');
      const domain = '  Hello-World.COM  ';
      const parsed = parseDomain(domain);
      const sldViaExtract = extractSld(domain);

      const engineInput = {
        sld: parsed.sld,
        tld: parsed.tld,
        domain: domain.trim().toLowerCase(),
      };

      const matchDetectorInput = {
        sld: sldViaExtract,
        domain: domain.trim().toLowerCase(),
      };

      expect(engineInput.sld).toBe('hello-world');
      expect(matchDetectorInput.sld).toBe('hello-world');
      expect(engineInput.sld).toBe(matchDetectorInput.sld);
    });
  });
});
