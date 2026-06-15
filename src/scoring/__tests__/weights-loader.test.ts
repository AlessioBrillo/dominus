import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWeights,
  WEIGHTS_OVERRIDE_SUM_TOLERANCE,
  resolveEffectiveWeights,
  computeEffectiveThresholds,
} from '../weights-loader.js';
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

describe('resolveEffectiveWeights', () => {
  it('returns DEFAULT_WEIGHTS when all signals are available', () => {
    const result = resolveEffectiveWeights({
      intrinsic: true,
      commercial: true,
      market: true,
      expiry: true,
    });
    expect(result).toEqual(DEFAULT_WEIGHTS);
  });

  it('returns DEFAULT_WEIGHTS when >= 70% weight has data', () => {
    const result = resolveEffectiveWeights({
      intrinsic: true,
      commercial: true,
      market: false,
      expiry: true,
    });
    // Available: intrinsic(0.3) + commercial(0.35) + expiry(0.1) = 0.75 >= 0.70
    expect(result).toEqual(DEFAULT_WEIGHTS);
  });

  it('redistributes all weight to intrinsic when only intrinsic is available', () => {
    const result = resolveEffectiveWeights({
      intrinsic: true,
      commercial: false,
      market: false,
      expiry: false,
    });
    expect(result.intrinsic).toBeCloseTo(1.0, 5);
    expect(result.commercial).toBe(0);
    expect(result.market).toBe(0);
    expect(result.expiry).toBe(0);
  });

  it('redistributes to intrinsic and expiry proportionally when both are available', () => {
    const result = resolveEffectiveWeights({
      intrinsic: true,
      commercial: false,
      market: false,
      expiry: true,
    });
    // DEFAULT: intrinsic=0.3, expiry=0.1. Total=0.40. ToRedistribute=0.60.
    // Fallback: intrinsic=0.6, expiry=0.4. Total fallback=1.0.
    // intrinsic gets: 0.3 + 0.60 * (0.6/1.0) = 0.3 + 0.36 = 0.66
    // expiry gets: 0.1 + 0.60 * (0.4/1.0) = 0.1 + 0.24 = 0.34
    expect(result.intrinsic).toBeCloseTo(0.66, 5);
    expect(result.expiry).toBeCloseTo(0.34, 5);
  });

  it('respects custom weights when provided', () => {
    const customDefaults = { intrinsic: 0.5, commercial: 0.5, market: 0, expiry: 0 };
    const result = resolveEffectiveWeights(
      { intrinsic: true, commercial: false, market: false, expiry: false },
      customDefaults,
    );
    expect(result.intrinsic).toBeCloseTo(1.0, 5);
    expect(result.commercial).toBe(0);
  });

  it('all weight goes to expiry when only expiry is available', () => {
    const result = resolveEffectiveWeights({
      intrinsic: true,
      commercial: false,
      market: false,
      expiry: true,
    });
    expect(result.expiry).toBeGreaterThan(0);
    expect(result.commercial).toBe(0);
    expect(result.market).toBe(0);
  });
});

describe('computeEffectiveThresholds', () => {
  it('returns default thresholds when all signals are available', () => {
    const result = computeEffectiveThresholds({
      intrinsic: true,
      commercial: true,
      market: true,
      expiry: true,
    });
    expect(result.effectiveRecommendThreshold).toBe(0.4);
    expect(result.effectiveConfidenceThreshold).toBe(0.3);
  });

  it('lowers thresholds proportionally when only intrinsic is available', () => {
    const result = computeEffectiveThresholds({
      intrinsic: true,
      commercial: false,
      market: false,
      expiry: false,
    });
    // ratio = 0.30/0.70 = 0.42857, round2(0.2857) = 0.29
    // rec = 0.20 + 0.20 * 0.429 = 0.2857 → round2 → 0.29
    // conf = 0.18 + 0.12 * 0.429 = 0.2314 → round2 → 0.23
    expect(result.effectiveRecommendThreshold).toBe(0.29);
    expect(result.effectiveConfidenceThreshold).toBe(0.23);
  });

  it('applies full threshold only when data coverage reaches SIGNAL_DATA_THRESHOLD', () => {
    // intrinsic(0.3) + commercial(0.35) = 0.65 < 0.70
    const sparse = computeEffectiveThresholds({
      intrinsic: true,
      commercial: true,
      market: false,
      expiry: false,
    });
    // ratio = 0.65/0.70 = 0.92857, round2(0.3857) = 0.39
    // rec = 0.20 + 0.20 * 0.929 = 0.3857 → round2 → 0.39
    // conf = 0.18 + 0.12 * 0.929 = 0.2914 → round2 → 0.29
    expect(sparse.effectiveRecommendThreshold).toBe(0.39);
    expect(sparse.effectiveConfidenceThreshold).toBe(0.29);

    // intrinsic(0.3) + commercial(0.35) + market(0.25) = 0.90 >= 0.70
    const full = computeEffectiveThresholds({
      intrinsic: true,
      commercial: true,
      market: true,
      expiry: false,
    });
    expect(full.effectiveRecommendThreshold).toBe(0.4);
    expect(full.effectiveConfidenceThreshold).toBe(0.3);
  });
});
