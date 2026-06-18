import { cn } from '@/lib/utils';

interface ScoreGaugeProps {
  label: string;
  value: number;
  max?: number;
  className?: string;
}

export function ScoreGauge({ label, value, max = 1, className }: ScoreGaugeProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const barColor = pct >= 70 ? 'bg-success' : pct >= 40 ? 'bg-warning' : 'bg-danger';

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex justify-between text-xs">
        <span className="text-text-muted">{label}</span>
        <span className="text-text-secondary font-mono">{value.toFixed(3)}</span>
      </div>
      <div className="h-1.5 bg-bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
