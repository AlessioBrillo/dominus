// SPDX-License-Identifier: AGPL-3.0-only
import { useSustainability } from '@/hooks/useSustainability';
import type { CarryCostVerdict } from '@/api/sustainability';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const verdictVariant: Record<CarryCostVerdict, 'success' | 'warning' | 'danger' | 'outline'> = {
  sustainable: 'success',
  marginal: 'warning',
  loss: 'danger',
  insufficient_data: 'outline',
};

function eur(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}€${Math.abs(value).toFixed(2)}`;
}

/**
 * Carry-cost sustainability (ADR-0083, M5): what each held domain earns
 * per year from ads against what it costs to renew. Verdicts are
 * conservative — less than 30 days of revenue data is never judged.
 */
export function CarryCostCard() {
  const { data: verdicts = [], isLoading } = useSustainability();

  const judged = verdicts.filter((v) => v.verdict !== 'insufficient_data');
  const netAnnual = judged.reduce((sum, v) => sum + v.netAnnualEur, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Carry cost vs ad revenue</CardTitle>
        <CardDescription>
          {judged.length > 0
            ? `Portfolio net: ${eur(netAnnual)}/year across ${String(judged.length)} monetized domain(s).`
            : 'No domain has enough revenue data to judge yet (30 days minimum).'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : verdicts.length === 0 ? (
          <p className="text-sm text-text-muted">
            No portfolio domains to evaluate. Revenue appears here once a domain has been through
            the parking step and its revenue is recorded.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="carry-cost-table">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="py-2 font-medium">Domain</th>
                <th className="py-2 font-medium">Revenue / yr</th>
                <th className="py-2 font-medium">Renewal / yr</th>
                <th className="py-2 font-medium">Net / yr</th>
                <th className="py-2 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {verdicts.map((v) => (
                <tr key={v.domain} className="border-t border-border">
                  <td className="py-2 text-text-primary">{v.domain}</td>
                  <td className="py-2 text-text-secondary">{eur(v.annualRevenueEur)}</td>
                  <td className="py-2 text-text-secondary">{eur(v.annualCarryCostEur)}</td>
                  <td
                    className={`py-2 font-medium ${v.netAnnualEur < 0 ? 'text-danger' : 'text-success'}`}
                  >
                    {eur(v.netAnnualEur)}
                  </td>
                  <td className="py-2">
                    <Badge variant={verdictVariant[v.verdict]}>{v.verdict.replace('_', ' ')}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
