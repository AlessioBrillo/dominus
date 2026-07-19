import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface MetricCardProps {
  label: string;
  value: string;
  accent?: string;
  subtext?: string;
}

export function MetricCard({
  label,
  value,
  accent = 'text-text-primary',
  subtext,
}: MetricCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold font-mono ${accent}`}>{value}</div>
        {subtext && <p className="text-xs text-text-muted mt-1">{subtext}</p>}
      </CardContent>
    </Card>
  );
}
