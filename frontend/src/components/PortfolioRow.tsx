import type { PortfolioEntry } from '../types/domain.js';

interface PortfolioRowProps {
  entry: PortfolioEntry;
  onDelete?: (domain: string) => void;
}

const verdictColors: Record<string, string> = {
  keep: 'bg-emerald-900/50 text-emerald-400 border border-emerald-800',
  drop: 'bg-red-900/50 text-red-400 border border-red-800',
  reprice: 'bg-amber-900/50 text-amber-400 border border-amber-800',
};

export function PortfolioRow({ entry, onDelete }: PortfolioRowProps) {
  const renewalDate = new Date(entry.renewalDate);
  const daysUntilRenewal = Math.ceil(
    (renewalDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );

  return (
    <tr className="border-b border-gray-800 hover:bg-gray-900/50 transition-colors">
      <td className="py-3 px-4">
        <div className="font-medium text-gray-100">{entry.domain}</div>
        <div className="text-xs text-gray-500">{entry.registrar}</div>
      </td>
      <td className="py-3 px-4 text-sm text-gray-300 font-mono">
        €{entry.acquisitionCost.toFixed(2)}
      </td>
      <td className="py-3 px-4">
        <div className="text-sm text-gray-300">
          {renewalDate.toLocaleDateString()}
        </div>
        <div
          className={`text-xs font-medium ${
            daysUntilRenewal < 30
              ? 'text-red-400'
              : daysUntilRenewal < 60
                ? 'text-amber-400'
                : 'text-gray-500'
          }`}
        >
          {daysUntilRenewal > 0 ? `${daysUntilRenewal}d` : 'Overdue'}
        </div>
      </td>
      <td className="py-3 px-4 font-mono text-sm text-gray-300">
        {entry.currentScore !== null && entry.currentScore !== undefined
          ? entry.currentScore.toFixed(2)
          : '—'}
      </td>
      <td className="py-3 px-4 font-mono text-sm text-gray-300">
        {entry.suggestedListPrice !== null && entry.suggestedListPrice !== undefined
          ? `€${entry.suggestedListPrice.toFixed(2)}`
          : '—'}
      </td>
      <td className="py-3 px-4">
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            verdictColors[entry.verdict] ?? 'bg-gray-800 text-gray-500'
          }`}
        >
          {entry.verdict}
        </span>
      </td>
      <td className="py-3 px-4">
        {onDelete && (
          <button
            onClick={() => onDelete(entry.domain)}
            className="text-gray-600 hover:text-red-400 transition-colors text-xs"
            title="Remove from portfolio"
          >
            ✕
          </button>
        )}
      </td>
    </tr>
  );
}
