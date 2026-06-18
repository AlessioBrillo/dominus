import { Badge } from '@/components/ui/badge';
import type { PortfolioEntry } from '@/types/domain';

interface PortfolioRowProps {
  entry: PortfolioEntry;
}

const verdictVariant = (v: string) => {
  switch (v) {
    case 'keep':
      return 'success' as const;
    case 'reprice':
      return 'warning' as const;
    case 'drop':
      return 'danger' as const;
    default:
      return 'outline' as const;
  }
};

export function PortfolioRow({ entry }: PortfolioRowProps) {
  return (
    <tr className="border-b border-border hover:bg-bg-hover transition-colors">
      <td className="py-3 px-4">
        <span className="font-mono text-sm font-medium text-text-primary">{entry.domain}</span>
      </td>
      <td className="py-3 px-4 text-sm text-text-secondary">
        €{entry.acquisitionCost?.toFixed(2) ?? '—'}
      </td>
      <td className="py-3 px-4">
        <span className="text-sm font-mono text-text-secondary">
          {entry.renewalDate ? new Date(entry.renewalDate).toLocaleDateString() : '—'}
        </span>
      </td>
      <td className="py-3 px-4">
        {entry.currentScore != null && (
          <span className="font-mono text-sm text-text-primary">
            {(entry.currentScore * 100).toFixed(0)}
          </span>
        )}
      </td>
      <td className="py-3 px-4">
        {entry.suggestedListPrice != null && (
          <span className="font-mono text-sm text-accent">
            €{entry.suggestedListPrice.toFixed(0)}
          </span>
        )}
      </td>
      <td className="py-3 px-4">
        <Badge variant={verdictVariant(entry.verdict)}>{entry.verdict}</Badge>
      </td>
    </tr>
  );
}
