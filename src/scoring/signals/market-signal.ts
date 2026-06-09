import type { CompsProvider } from '../../providers/comps/comps-provider.js';
import type { SignalOutput, ScoringInput } from '../../types/score.js';
import type { MarketSignalConfig } from '../scoring-config.js';
import { DEFAULT_MARKET_CONFIG } from '../scoring-config.js';

export async function computeMarketScore(
  input: ScoringInput,
  provider: CompsProvider,
  weight: number,
  config: MarketSignalConfig = DEFAULT_MARKET_CONFIG,
): Promise<SignalOutput & { medianSalePrice: number }> {
  const sld = input.sld;
  const sales = await provider.getSales(sld);

  if (sales.length === 0) {
    return {
      score: 0,
      weight,
      details: { comparables: 0, medianSalePrice: 0 },
      medianSalePrice: 0,
    };
  }

  const prices = sales.map((s) => s.salePrice).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0
      ? ((prices[mid - 1] ?? 0) + (prices[mid] ?? 0)) / 2
      : (prices[mid] ?? 0);

  const score = Math.min(
    1,
    Math.max(0, (median - config.floorValue) / (config.highValue - config.floorValue)),
  );

  return {
    score,
    weight,
    details: { comparables: sales.length, medianSalePrice: median },
    medianSalePrice: median,
  };
}
