interface ScoreGaugeProps {
  value: number;
  label: string;
  max?: number;
}

export function ScoreGauge({ value, label, max = 1 }: ScoreGaugeProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const color =
    pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className="font-mono text-gray-200">{value.toFixed(2)}</span>
      </div>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
