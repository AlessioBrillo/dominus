// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  useRegistrarCatalog,
  useTco,
  useRegistrarRecommendation,
} from '@/hooks/useRegistrarCatalog';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';

function eur(value: number): string {
  return `€${value.toFixed(2)}`;
}

export function RegistrarCatalogPage() {
  const {
    tlds,
    registrars,
    selectedTld,
    matrix,
    isLoading: matrixLoading,
    loadRegistrars,
    loadMatrix,
  } = useRegistrarCatalog();

  const { result: tcoResult, isLoading: tcoLoading, compute: computeTco } = useTco();
  const {
    result: recommendation,
    isLoading: recLoading,
    recommend: recommendRegistrar,
  } = useRegistrarRecommendation();

  const [newDomain, setNewDomain] = useState('');
  const [holdingYears, setHoldingYears] = useState(3);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Registrar catalog"
        subtitle="Compare registrar prices and total cost of ownership across TLDs"
      />

      <Card>
        <CardHeader>
          <CardTitle>Registrars in catalog</CardTitle>
          <CardDescription>
            Registrars with verified price data. Prices are the public list price in EUR, excluding
            bulk discounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {registrars.length === 0 ? (
            <EmptyState title="No registrar data" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-2 font-medium">Registrar</th>
                  <th className="py-2 font-medium">TLDs</th>
                  <th className="py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {registrars.map((r) => (
                  <tr key={r.name} className="border-t border-border">
                    <td className="py-2 text-text-primary">{r.name}</td>
                    <td className="py-2 text-text-secondary">{r.tlds.join(', ')}</td>
                    <td className="py-2 text-text-muted text-xs">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Price matrix by TLD</CardTitle>
          <CardDescription>
            Select a TLD to see register / renew / transfer prices per registrar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 items-center">
            <select
              value={selectedTld}
              onChange={(e) => loadMatrix(e.target.value)}
              disabled={matrixLoading}
              className="h-9 w-[200px] rounded-lg border border-border bg-transparent px-3 py-1 text-sm text-text-primary shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Choose a TLD</option>
              {tlds.map((t) => (
                <option key={t} value={t}>
                  .{t}
                </option>
              ))}
            </select>
            <Button onClick={loadRegistrars} disabled={matrixLoading}>
              Refresh registrars
            </Button>
          </div>

          {matrixLoading ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : matrix ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-2 font-medium">Registrar</th>
                  <th className="py-2 font-medium">Register</th>
                  <th className="py-2 font-medium">Renew / yr</th>
                  <th className="py-2 font-medium">Transfer</th>
                </tr>
              </thead>
              <tbody>
                {matrix.prices.map((p) => (
                  <tr key={p.registrar} className="border-t border-border">
                    <td className="py-2 text-text-primary">{p.registrar}</td>
                    <td className="py-2 text-text-secondary">{eur(p.register)}</td>
                    <td className="py-2 text-text-secondary">{eur(p.renew)}</td>
                    <td className="py-2 text-text-secondary">{eur(p.transfer)}</td>
                  </tr>
                ))}
                <tr className="border-t border-border font-semibold bg-bg-hover">
                  <td className="py-2">Cheapest</td>
                  <td className="py-2">{eur(matrix.cheapestPrice)}</td>
                  <td className="py-2" colSpan={2}>
                    {matrix.cheapestRegistrar}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <EmptyState title="Select a TLD to see its price matrix" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Total cost of ownership (TCO)</CardTitle>
          <CardDescription>
            Compare what a domain costs to hold over several years at each registrar, including
            registration and renewals.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <span className="text-xs text-text-muted block mb-1">Domain</span>
              <Input
                id="tco-domain"
                placeholder="example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <span className="text-xs text-text-muted block mb-1">Years</span>
              <Input
                id="tco-years"
                type="number"
                min={1}
                max={20}
                value={String(holdingYears)}
                onChange={(e) =>
                  setHoldingYears(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))
                }
              />
            </div>
            <div className="space-y-2">
              <span className="text-xs text-text-muted block mb-1">&nbsp;</span>
              <Button
                onClick={() => {
                  if (!newDomain) return;
                  void computeTco(newDomain, holdingYears);
                }}
                disabled={tcoLoading}
              >
                {tcoLoading ? 'Computing…' : 'Compute TCO'}
              </Button>
            </div>
          </div>

          {tcoLoading ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : tcoResult ? (
            <div className="p-4 rounded-lg border border-border bg-bg-elevated">
              <div className="text-xs text-text-muted mb-2">
                {tcoResult.domain} — {tcoResult.holdingYears} years at {tcoResult.registrar}
              </div>
              <div className="text-2xl font-semibold">Total: {eur(tcoResult.totalCostEur)}</div>
              <table className="w-full text-sm mt-4">
                <thead>
                  <tr className="text-left text-text-muted">
                    <th className="py-2">Year</th>
                    <th className="py-2">Cost</th>
                    <th className="py-2">Label</th>
                  </tr>
                </thead>
                <tbody>
                  {tcoResult.breakdown.map((b) => (
                    <tr key={b.year} className="border-t border-border">
                      <td className="py-2">{b.year}</td>
                      <td className="py-2">{eur(b.costEur)}</td>
                      <td className="py-2 text-text-muted text-xs">{b.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="Enter a domain and click Compute TCO" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registrar recommendation</CardTitle>
          <CardDescription>
            The cheapest registrar for a domain over your holding period, and how much you save
            versus the next-best option.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <span className="text-xs text-text-muted block mb-1">Domain</span>
              <Input
                id="rec-domain"
                placeholder="example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <span className="text-xs text-text-muted block mb-1">Years</span>
              <Input
                id="rec-years"
                type="number"
                min={1}
                max={20}
                value={String(holdingYears)}
                onChange={(e) =>
                  setHoldingYears(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))
                }
              />
            </div>
            <div className="space-y-2">
              <span className="text-xs text-text-muted block mb-1">&nbsp;</span>
              <Button
                onClick={() => {
                  if (!newDomain) return;
                  void recommendRegistrar(newDomain, holdingYears);
                }}
                disabled={recLoading}
              >
                {recLoading ? 'Computing…' : 'Get recommendation'}
              </Button>
            </div>
          </div>

          {recLoading ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : recommendation ? (
            <div className="p-4 rounded-lg border border-border bg-bg-elevated">
              <div className="text-xs text-text-muted mb-2">
                {recommendation.domain} — {recommendation.holdingYears} years
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold">
                  {recommendation.recommendedRegistrar}
                </span>
                <Badge variant="success">Cheapest</Badge>
              </div>
              <p className="text-sm text-text-secondary">
                Savings vs next-best: {eur(recommendation.savingsEur)}
              </p>
              <p className="text-sm text-text-muted">{recommendation.rationale}</p>
            </div>
          ) : (
            <EmptyState title="Enter a domain and click Get recommendation" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
