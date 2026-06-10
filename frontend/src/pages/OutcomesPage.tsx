import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { Outcome } from '../types/domain.js';

export function OutcomesPage() {
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ outcomes: Outcome[] }>('/api/outcomes')
      .then((data) => setOutcomes(data.outcomes))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-gray-500 animate-pulse">Loading outcomes...</div>;
  }

  const sold = outcomes.filter((o) => o.type === 'sold');
  const totalRevenue = sold.reduce((sum, o) => sum + (o.salePriceEur ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100">Outcomes</h2>
        <p className="text-sm text-gray-500 mt-1">
          {sold.length} sales — €{totalRevenue.toFixed(2)} total revenue
        </p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Stat label="Sold" value={outcomes.filter((o) => o.type === 'sold').length} />
        <Stat label="Dropped" value={outcomes.filter((o) => o.type === 'dropped').length} />
        <Stat label="Expired" value={outcomes.filter((o) => o.type === 'expired').length} />
        <Stat label="Renewed" value={outcomes.filter((o) => o.type === 'renewed').length} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900">
            <tr className="text-left text-gray-500 text-xs uppercase">
              <th className="py-3 px-4">Domain</th>
              <th className="py-3 px-4">Type</th>
              <th className="py-3 px-4">Date</th>
              <th className="py-3 px-4">Sale Price</th>
              <th className="py-3 px-4">Venue</th>
              <th className="py-3 px-4">Notes</th>
            </tr>
          </thead>
          <tbody className="bg-gray-950">
            {outcomes.map((o) => (
              <tr key={o.id} className="border-b border-gray-800">
                <td className="py-3 px-4 font-medium text-gray-200">{o.domain}</td>
                <td className="py-3 px-4">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      o.type === 'sold'
                        ? 'bg-emerald-900/50 text-emerald-400'
                        : o.type === 'dropped'
                          ? 'bg-red-900/50 text-red-400'
                          : o.type === 'expired'
                            ? 'bg-gray-800 text-gray-500'
                            : 'bg-blue-900/50 text-blue-400'
                    }`}
                  >
                    {o.type}
                  </span>
                </td>
                <td className="py-3 px-4 text-gray-400">{new Date(o.occurredAt).toLocaleDateString()}</td>
                <td className="py-3 px-4 font-mono text-gray-300">
                  {o.salePriceEur ? `€${o.salePriceEur.toFixed(2)}` : '—'}
                </td>
                <td className="py-3 px-4 text-gray-400">{o.venue ?? '—'}</td>
                <td className="py-3 px-4 text-gray-500 max-w-48 truncate">{o.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-bold mt-1 text-gray-100 font-mono">{value}</div>
    </div>
  );
}
