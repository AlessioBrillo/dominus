import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import { fetchPortfolio, rescorePortfolio } from '../api/portfolio.js';
import type { PortfolioEntry } from '../types/domain.js';
import { PortfolioRow } from '../components/PortfolioRow.js';

export function PortfolioPage() {
  const [entries, setEntries] = useState<PortfolioEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [rescoring, setRescoring] = useState(false);

  useEffect(() => {
    fetchPortfolio()
      .then((data) => setEntries(data.portfolio))
      .finally(() => setLoading(false));
  }, []);

  const handleRescore = async () => {
    setRescoring(true);
    try {
      const result = await rescorePortfolio();
      const updated = await fetchPortfolio();
      setEntries(updated.portfolio);
      alert(`Rescore complete: ${result.results.length} domains processed in ${(result.totalDurationMs / 1000).toFixed(1)}s`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Rescore failed';
      alert(`Rescore failed: ${message}`);
    } finally {
      setRescoring(false);
    }
  };

  const keepEntries = entries.filter((e) => e.verdict === 'keep');
  const dropEntries = entries.filter((e) => e.verdict === 'drop');
  const repriceEntries = entries.filter((e) => e.verdict === 'reprice' || e.verdict === 'hold');

  if (loading) {
    return <div className="text-gray-500 animate-pulse">Loading portfolio...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-100">Portfolio</h2>
          <p className="text-sm text-gray-500 mt-1">
            {entries.length} domains — {keepEntries.length} keep / {dropEntries.length} drop /{' '}
            {repriceEntries.length} reprice
          </p>
        </div>
        <button
          onClick={handleRescore}
          disabled={rescoring}
          className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {rescoring ? 'Rescoring...' : 'Rescore All'}
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="text-center py-12 text-gray-600">
          No domains in portfolio. Add domains to start tracking.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900">
              <tr className="text-left text-gray-500 text-xs uppercase">
                <th className="py-3 px-4">Domain</th>
                <th className="py-3 px-4">Cost</th>
                <th className="py-3 px-4">Renewal</th>
                <th className="py-3 px-4">Score</th>
                <th className="py-3 px-4">List Price</th>
                <th className="py-3 px-4">Verdict</th>
              </tr>
            </thead>
            <tbody className="bg-gray-950">
              {keepEntries.map((entry) => (
                <PortfolioRow key={entry.id} entry={entry} />
              ))}
              {repriceEntries.map((entry) => (
                <PortfolioRow key={entry.id} entry={entry} />
              ))}
              {dropEntries.map((entry) => (
                <PortfolioRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
