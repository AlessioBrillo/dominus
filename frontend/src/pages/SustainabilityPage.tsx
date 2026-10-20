// SPDX-License-Identifier: AGPL-3.0-only
import { useSustainability } from '@/hooks/useSustainability';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { CarryCostCard } from '@/components/CarryCostCard';

const verdictVariant: Record<
  'sustainable' | 'marginal' | 'loss' | 'insufficient_data',
  'success' | 'warning' | 'danger' | 'outline'
> = {
  sustainable: 'success',
  marginal: 'warning',
  loss: 'danger',
  insufficient_data: 'outline',
};

function eur(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}€${Math.abs(value).toFixed(2)}`;
}

export function SustainabilityPage() {
  const { data: verdicts = [], isLoading } = useSustainability();

  const judged = verdicts.filter((v) => v.verdict !== 'insufficient_data');
  const netAnnual = judged.reduce((sum, v) => sum + v.netAnnualEur, 0);
  const lossCount = verdicts.filter((v) => v.verdict === 'loss').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sustainability"
        subtitle="Carry cost vs ad revenue — which domains pay for themselves"
      />

      <Card>
        <CardHeader>
          <CardTitle>Portfolio carry cost</CardTitle>
          <CardDescription>
            Annualised ad revenue versus the yearly renewal cost for every held domain. Verdicts are
            conservative — less than 30 days of revenue data is never judged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-40 w-full rounded-lg" />
          ) : verdicts.length === 0 ? (
            <EmptyState
              title="No portfolio domains yet"
              description="Domains appear here once they are in your portfolio and have passed through the parking step."
            />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="p-4 rounded-lg border border-border bg-bg-elevated">
                  <div className="text-xs text-text-muted">Net per year</div>
                  <div className="text-2xl font-semibold">
                    {netAnnual >= 0 ? '+' : ''}
                    {eur(netAnnual)}
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-border bg-bg-elevated">
                  <div className="text-xs text-text-muted">Domains judged</div>
                  <div className="text-2xl font-semibold">{String(judged.length)}</div>
                </div>
                <div className="p-4 rounded-lg border border-border bg-bg-elevated">
                  <div className="text-xs text-text-muted">Loss-making</div>
                  <div
                    className={`text-2xl font-semibold ${
                      lossCount > 0 ? 'text-danger' : 'text-success'
                    }`}
                  >
                    {String(lossCount)}
                  </div>
                </div>
              </div>

              <CarryCostCard />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Verdict details</CardTitle>
          <CardDescription>How the carry-cost verdict is computed for each domain.</CardDescription>
        </CardHeader>
        <CardContent>
          {verdicts.length === 0 ? (
            <p className="text-sm text-text-muted">
              No data yet. Revenue appears once a domain has been through the parking step and its
              ad revenue is recorded.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-2 font-medium">Domain</th>
                  <th className="py-2 font-medium">Revenue / yr</th>
                  <th className="py-2 font-medium">Renewal / yr</th>
                  <th className="py-2 font-medium">Net / yr</th>
                  <th className="py-2 font-medium">Verdict</th>
                  <th className="py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {verdicts.map((v) => (
                  <tr key={v.domain} className="border-t border-border">
                    <td className="py-2 text-text-primary">{v.domain}</td>
                    <td className="py-2 text-text-secondary">{eur(v.annualRevenueEur)}</td>
                    <td className="py-2 text-text-secondary">{eur(v.annualCarryCostEur)}</td>
                    <td
                      className={`py-2 font-medium ${
                        v.netAnnualEur < 0 ? 'text-danger' : 'text-success'
                      }`}
                    >
                      {eur(v.netAnnualEur)}
                    </td>
                    <td className="py-2">
                      <Badge variant={verdictVariant[v.verdict]}>
                        {v.verdict.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="py-2 text-text-muted text-xs max-w-xs truncate">{v.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
