import type { Candidate } from '../types/domain.js';
import { ScoreGauge } from './ScoreGauge.js';

interface CandidateCardProps {
  candidate: Candidate;
  onScore?: (domain: string) => void;
}

export function CandidateCard({ candidate, onScore }: CandidateCardProps) {
  const score = candidate.scoreResult;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 hover:border-gray-700 transition-colors">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-100">{candidate.domain}</h3>
          <span className="text-xs text-gray-500">Source: {candidate.source}</span>
        </div>
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
