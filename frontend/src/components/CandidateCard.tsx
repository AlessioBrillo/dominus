import type { Candidate } from '../types/domain.js';
import { ScoreGauge } from './ScoreGauge.js';
import { preflightPurchase, executePurchase } from '../api/purchase.js';
import { useState } from 'react';

interface CandidateCardProps {
  candidate: Candidate;
  onScore?: (domain: string) => void;
  onDelete?: (domain: string) => void;
}

export function CandidateCard({ candidate, onScore, onDelete }: CandidateCardProps) {
  const [buying, setBuying] = useState(false);
  const [buyResult, setBuyResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
  } | null>(null);

  const score = candidate.scoreResult;

  const handleBuy = async () => {
    if (!confirm(`Buy ${candidate.domain}? Check the price and proceed with purchase.`)) return;
    setBuying(true);
    setBuyResult(null);
    try {
      const check = await preflightPurchase(candidate.domain);
      if (!check.check.available) {
        setBuyResult({ success: false, error: 'Domain is not available for registration' });
        setBuying(false);
        return;
      }
      if (!check.check.trademarkClear) {
        setBuyResult({ success: false, error: 'Domain did not pass trademark gate' });
        setBuying(false);
        return;
      }
      const price = check.check.registerPriceEur ?? 0;
      if (!confirm(`Purchase ${candidate.domain} for €${price.toFixed(2)}?`)) {
        setBuying(false);
        return;
      }
      const result = await executePurchase(candidate.domain, 1, true);
      setBuyResult(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Purchase failed';
      setBuyResult({ success: false, error: message });
    } finally {
      setBuying(false);
    }
  };

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 hover:border-gray-700 transition-colors">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-100">{candidate.domain}</h3>
          <span className="text-xs text-gray-500">Source: {candidate.source}</span>
        </div>
        <div className="flex items-center gap-2">
          {onDelete && (
            <button
              onClick={() => onDelete(candidate.domain)}
              className="text-gray-600 hover:text-red-400 transition-colors text-xs"
              title="Remove candidate"
            >
              ✕
            </button>
          )}
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${
              candidate.status === 'recommended'
                ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-800'
                : candidate.status === 'scored'
                  ? 'bg-amber-900/50 text-amber-400 border border-amber-800'
                  : 'bg-gray-800 text-gray-500'
            }`}
          >
            {candidate.status}
          </span>
        </div>
      </div>

      {score ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-gray-950 rounded-lg p-3">
              <div className="text-gray-500 text-xs">Expected Value</div>
              <div className="font-mono text-emerald-400 font-bold">
                €{score.expectedValue.toFixed(2)}
              </div>
            </div>
            <div className="bg-gray-950 rounded-lg p-3">
              <div className="text-gray-500 text-xs">Confidence</div>
              <div className="font-mono text-cyan-400 font-bold">
                {(score.confidence * 100).toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-950 rounded-lg p-3">
              <div className="text-gray-500 text-xs">Buy Max</div>
              <div className="font-mono text-amber-400 font-bold">
                €{score.suggestedBuyMax.toFixed(2)}
              </div>
            </div>
            <div className="bg-gray-950 rounded-lg p-3">
              <div className="text-gray-500 text-xs">List Price</div>
              <div className="font-mono text-purple-400 font-bold">
                €{score.suggestedListPrice.toFixed(2)}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <ScoreGauge value={score.breakdown.intrinsic.score} label="Intrinsic" />
            <ScoreGauge value={score.breakdown.commercial.score} label="Commercial" />
            <ScoreGauge value={score.breakdown.market.score} label="Market" />
            <ScoreGauge value={score.breakdown.expiry.score} label="Expiry" />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleBuy}
              disabled={buying}
              className="flex-1 px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {buying ? 'Processing...' : 'Buy'}
            </button>
          </div>

          {buyResult && (
            <div
              className={`text-xs px-3 py-2 rounded-lg ${buyResult.success ? 'bg-emerald-900/30 text-emerald-400' : 'bg-red-900/30 text-red-400'}`}
            >
              {buyResult.success ? buyResult.message : buyResult.error}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">Not yet scored</span>
          {onScore && (
            <button
              onClick={() => onScore(candidate.domain)}
              className="px-3 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 rounded-lg transition-colors"
            >
              Score Now
            </button>
          )}
        </div>
      )}
    </div>
  );
}
