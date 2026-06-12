import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import { rescorePortfolio } from '../api/portfolio.js';
import type { PortfolioEntry } from '../types/domain.js';
import { PortfolioRow } from '../components/PortfolioRow.js';

export function PortfolioPage() {
  const [entries, setEntries] = useState<PortfolioEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [rescoring, setRescoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ portfolio: PortfolioEntry[] }>('/portfolio')
      .then((data) => setEntries(data.portfolio))
      .catch(() => setError('Failed to load portfolio'))
      .finally(() => setLoading(false));
  }, []);

  const handleRescore = async () => {
    setRescoring(true);
    setError(null);
    try {
      const result = await rescorePortfolio();
      const updated = await api.get<{ portfolio: PortfolioEntry[] }>('/portfolio');
      setEntries(updated.portfolio);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Rescore failed');
    } finally {
      setRescoring(false);
    }
  };

  const handleRefreshVerdicts = async () => {
    try {
      await api.post('/portfolio/verdicts');
      const updated = await api.get<{ portfolio: PortfolioEntry[] }>('/portfolio');
      setEntries(updated.portfolio);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Verdict refresh failed');
    }
  };

  const handleDelete = async (domain: string) => {
    if (!confirm(`Remove ${domain} from portfolio?`)) return;
    try {
      await api.delete(`/portfolio/${encodeURIComponent(domain)}`);
      setEntries((prev) => prev.filter((e) => e.domain !== domain));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
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
        <div className="flex gap-2">
          <button
            onClick={handleRefreshVerdicts}
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-colors"
          >
            Refresh Verdicts
          </button>
          <button
            onClick={handleRescore}
            disabled={rescoring}
            className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {rescoring ? 'Rescoring...' : 'Rescore All'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/50 border border-red-900 text-red-400 px-4 py-3 rounded-lg text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-3 underline">
            Dismiss
          </button>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="text-center py-12 text-gray-600">
          No domains in portfolio. Use the CLI to add domains.
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
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="bg-gray-950">
              {keepEntries.map((entry) => (
                <PortfolioRow key={entry.id} entry={entry} onDelete={handleDelete} />
              ))}
              {repriceEntries.map((entry) => (
                <PortfolioRow key={entry.id} entry={entry} onDelete={handleDelete} />
              ))}
              {dropEntries.map((entry) => (
                <PortfolioRow key={entry.id} entry={entry} onDelete={handleDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
