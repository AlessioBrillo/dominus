import { PiggyBank, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SavingsCalloutProps {
  annualSavingsEur: number;
  droppedDomains: number;
  className?: string;
}

export function SavingsCallout({
  annualSavingsEur,
  droppedDomains,
  className,
}: SavingsCalloutProps) {
  if (annualSavingsEur <= 0) {
    return null;
  }

  const monthlySavings = annualSavingsEur / 12;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border border-success/30 bg-success/5 p-6',
        className,
      )}
    >
      <div className="absolute top-0 right-0 w-32 h-32 bg-success/10 rounded-full -translate-y-1/2 translate-x-1/2" />
      <div className="relative flex items-start gap-4">
        <div className="p-2 rounded-lg bg-success/10 shrink-0">
          <PiggyBank className="h-6 w-6 text-success" />
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-text-primary">Annual Savings Potential</h3>
          <p className="text-sm text-text-secondary mt-1">
            Dropping {droppedDomains} domain{droppedDomains !== 1 ? 's' : ''} saves you:
          </p>
          <div className="mt-3 flex items-baseline gap-1">
            <span className="text-3xl font-bold text-success font-mono">
              €{annualSavingsEur.toFixed(0)}
            </span>
            <span className="text-text-muted text-sm">/ year</span>
          </div>
          <p className="text-xs text-text-muted mt-1">
            ~€{monthlySavings.toFixed(0)}/month in renewal costs avoided
          </p>
          <div className="mt-4 flex items-center gap-2 text-sm font-medium text-brand-400">
            <span>Upgrade to Pro for automated renewal monitoring</span>
            <ArrowRight className="h-4 w-4" />
          </div>
        </div>
      </div>
    </div>
  );
}
