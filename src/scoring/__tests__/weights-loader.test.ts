import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWeights, WEIGHTS_OVERRIDE_SUM_TOLERANCE } from '../weights-loader.js';
import { DEFAULT_WEIGHTS } from '../weights.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dominus-weights-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadWeights', () => {
  it('returns DEFAULT_WEIGHTS when the override path is undefined', () => {
    const w = loadWeights(undefined);
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });

  it('returns DEFAULT_WEIGHTS when the override file does not exist', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const w = loadWeights(join(tmpDir, 'missing.json'));
    expect(w).toEqual(DEFAULT_WEIGHTS);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('missing file'));
    errSpy.mockRestore();
  });

  it('returns DEFAULT_WEIGHTS when the file is not valid JSON', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, 'not json at all', 'utf-8');
    const w = loadWeights(path);
    expect(w).toEqual(DEFAULT_WEIGHTS);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    errSpy.mockRestore();
  });

  it('returns DEFAULT_WEIGHTS when any signal key is missing', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const path = join(tmpDir, 'partial.json');
    writeFileSync(
      path,
      JSON.stringify({ weights: { intrinsic: 0.4, commercial: 0.3, market: 0.3 } }),
      'utf-8',
    );
    const w = loadWeights(path);
    expect(w).toEqual(DEFAULT_WEIGHTS);
    errSpy.mockRestore();
  });

  it('returns DEFAULT_WEIGHTS when a signal value is out of [0, 1]', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const path = join(tmpDir, 'bad-value.json');
    writeFileSync(
      path,
      JSON.stringify({ weights: { intrinsic: 0.4, commercial: 1.5, market: 0.3, expiry: 0.0 } }),
      'utf-8',
    );
    const w = loadWeights(path);
    expect(w).toEqual(DEFAULT_WEIGHTS);
    errSpy.mockRestore();
  });

  it('returns DEFAULT_WEIGHTS when the sum is too far from 1.0', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const path = join(tmpDir, 'bad-sum.json');
    writeFileSync(
      path,
      JSON.stringify({
        weights: { intrinsic: 0.1, commercial: 0.1, market: 0.1, expiry: 0.1 },
      }),
      'utf-8',
    );
    const w = loadWeights(path);
    expect(w).toEqual(DEFAULT_WEIGHTS);
    errSpy.mockRestore();
  });

  it('accepts a valid override file and uses its weights', () => {
    const path = join(tmpDir, 'good.json');
    writeFileSync(
      path,
      JSON.stringify({
        generatedAt: '2026-06-06T00:00:00.000Z',
        sampleSize: 10,
        weights: { intrinsic: 0.32, commercial: 0.3, market: 0.28, expiry: 0.1 },
      }),
      'utf-8',
    );
    const w = loadWeights(path);
    expect(w.intrinsic).toBeCloseTo(0.32, 5);
    expect(w.commercial).toBeCloseTo(0.3, 5);
    expect(w.market).toBeCloseTo(0.28, 5);
    expect(w.expiry).toBeCloseTo(0.1, 5);
  });

  it('exports a sum tolerance constant that the CLI can echo to the user', () => {
    expect(WEIGHTS_OVERRIDE_SUM_TOLERANCE).toBeGreaterThan(0);
    expect(WEIGHTS_OVERRIDE_SUM_TOLERANCE).toBeLessThan(0.01);
  });
});
