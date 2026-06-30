import type { CompsProvider, ComparableSale } from '../../providers/comps/comps-provider.js';
import type { SignalOutput, ScoringInput } from '../../types/score.js';
import type { MarketSignalConfig } from '../scoring-config.js';
import { DEFAULT_MARKET_CONFIG } from '../scoring-config.js';

export async function computeMarketScore(
  input: ScoringInput,
  provider: CompsProvider,
  weight: number,
  config: MarketSignalConfig = DEFAULT_MARKET_CONFIG,
  signal?: AbortSignal,
): Promise<SignalOutput & { medianSalePrice: number }> {
  // Engine always sets sld before calling signal functions;
  // non-null assertion is safe here (see ScoringEngine.score()).
  const sld = input.sld!;
  let sales: ComparableSale[];
  let providerError: string | undefined;

  try {
    sales = await provider.getSales(sld, signal);
  } catch (err) {
    providerError = err instanceof Error ? err.message : String(err);
    sales = [];
  }

  if (sales.length === 0) {
    return {
      score: 0,
      weight,
      dataAvailable: false,
      providerError,
      details: { comparables: 0, medianSalePrice: 0 },
      medianSalePrice: 0,
    };
  }

  const now = Date.now();
  const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

  const recencyWeight = (saleDate: string): number => {
    const ageMs = now - new Date(saleDate).getTime();
    if (Number.isNaN(ageMs) || ageMs < 0) return 0.5;
    const ageYears = ageMs / YEAR_MS;
    if (ageYears <= 1) return 1.0;
    if (ageYears <= 2) return 0.7;
    if (ageYears <= 5) return 0.4;
    return 0.2;
  };

  const weighted = sales
    .map((s) => ({ price: s.salePrice, weight: recencyWeight(s.saleDate) }))
    .sort((a, b) => a.price - b.price);

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  const halfWeight = totalWeight / 2;
  let cumulative = 0;
  let median = 0;

  for (let i = 0; i < weighted.length; i++) {
    cumulative += weighted[i]!.weight;
    if (cumulative >= halfWeight) {
      // When cumulative lands exactly on halfWeight and there's a next
      // element (equal-weight case), interpolate to match simple median.
      const next = weighted[i + 1];
      if (cumulative === halfWeight && next) {
        median = (weighted[i]!.price + next.price) / 2;
      } else {
        median = weighted[i]!.price;
      }
      break;
    }
  }

  const score = Math.min(
    1,
    Math.max(0, (median - config.floorValue) / (config.highValue - config.floorValue)),
  );

  return {
    score,
    weight,
    dataAvailable: true,
    providerError,
    details: { comparables: sales.length, medianSalePrice: median },
    medianSalePrice: median,
  };
}
