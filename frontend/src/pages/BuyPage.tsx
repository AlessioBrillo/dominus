import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ShoppingCart, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { usePreflight, useExecutePurchase } from '@/hooks/usePurchase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export function BuyPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const domain = searchParams.get('domain');
  const [years, setYears] = useState(1);

  const { data, isLoading, error } = usePreflight(domain);
  const execute = useExecutePurchase();

  if (!domain) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h2 className="text-2xl font-bold text-text-primary">Purchase</h2>
        </div>
        <Card>
          <CardContent className="py-8 text-center text-text-muted">
            No domain specified. Select a domain from candidates.
          </CardContent>
        </Card>
      </div>
    );
  }

  const check = data?.check;

  const handleExecute = () => {
    execute.mutate(
      { domain, years, operatorApproved: true },
      {
        onSuccess: () => {},
      },
    );
  };

  if (execute.isSuccess && data?.check) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate('/portfolio')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Portfolio
          </Button>
          <h2 className="text-2xl font-bold text-text-primary">Purchase Complete</h2>
        </div>
        <Card>
          <CardContent className="py-8 flex flex-col items-center gap-4">
            <CheckCircle className="h-16 w-16 text-success" />
            <h3 className="text-xl font-semibold font-mono">{domain}</h3>
            <p className="text-text-muted">
              Purchased for €{data.check.registerPriceEur?.toFixed(2) ?? '?'} via{' '}
              {execute.data?.purchase?.registrar ?? 'registrar'}
            </p>
            <Button variant="primary" onClick={() => navigate('/portfolio')}>
              View in Portfolio
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <h2 className="text-2xl font-bold text-text-primary">Purchase</h2>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span className="font-mono">{domain}</span>
            {check?.available === false && <Badge variant="danger">Unavailable</Badge>}
            {check?.trademarkClear === false && <Badge variant="danger">TM Blocked</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="space-y-4">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-danger">
              <AlertTriangle className="h-4 w-4" />
              <p className="text-sm">Failed to load purchase info</p>
            </div>
          )}

          {check && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-bg-muted rounded-lg p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wider">
                    Register Price
                  </div>
                  <div className="text-lg font-bold text-text-primary">
                    €{check.registerPriceEur?.toFixed(2) ?? '—'}
                  </div>
                </div>
                <div className="bg-bg-muted rounded-lg p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wider">
                    Renewal /yr
                  </div>
                  <div className="text-lg font-bold text-text-primary">
                    €{check.renewalPriceEur?.toFixed(2) ?? '—'}
                  </div>
                </div>
                <div className="bg-bg-muted rounded-lg p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wider">
                    Expected Value
                  </div>
                  <div className="text-lg font-bold text-success">
                    €{check.expectedValue?.toFixed(0) ?? '—'}
                  </div>
                </div>
                <div className="bg-bg-muted rounded-lg p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wider">Buy Max</div>
                  <div className="text-lg font-bold text-accent">
                    €{check.suggestedBuyMax?.toFixed(0) ?? '—'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-1">
                  <span className="text-text-muted">Confidence:</span>
                  <span
                    className={
                      check.confidence !== null && check.confidence >= 0.5
                        ? 'text-success font-semibold'
                        : 'text-warning font-semibold'
                    }
                  >
                    {check.confidence !== null ? `${(check.confidence * 100).toFixed(0)}%` : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-text-muted">TM Clear:</span>
                  <span
                    className={
                      check.trademarkClear
                        ? 'text-success font-semibold'
                        : 'text-danger font-semibold'
                    }
                  >
                    {check.trademarkClear ? 'Yes' : 'Blocked'}
                  </span>
                </div>
                {check.operatorApprovalRequired && (
                  <Badge variant="warning">Approval Required</Badge>
                )}
              </div>

              {check.available === false && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/10 text-danger text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  This domain is not available for registration.
                </div>
              )}

              {check.trademarkClear === false && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/10 text-danger text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Trademark check blocked — this domain matches a registered trademark.
                </div>
              )}

              <div className="flex items-center gap-2">
                <label className="text-sm text-text-muted">Registration period:</label>
                <select
                  value={years}
                  onChange={(e) => setYears(Number(e.target.value))}
                  className="bg-bg-muted border border-border rounded px-2 py-1 text-sm"
                  disabled={
                    check.available === false || check.trademarkClear === false || execute.isPending
                  }
                >
                  {[1, 2, 3, 5, 10].map((y) => (
                    <option key={y} value={y}>
                      {y} year{y > 1 ? 's' : ''}
                    </option>
                  ))}
                </select>
                {check.registerPriceEur !== null && years > 1 && (
                  <span className="text-xs text-text-muted">
                    (€{(check.registerPriceEur * years).toFixed(2)} total)
                  </span>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  variant="success"
                  onClick={handleExecute}
                  disabled={
                    check.available === false || check.trademarkClear === false || execute.isPending
                  }
                >
                  {execute.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Purchasing...
                    </>
                  ) : (
                    <>
                      <ShoppingCart className="h-4 w-4 mr-2" />
                      Purchase {domain}
                    </>
                  )}
                </Button>
                <Button variant="ghost" onClick={() => navigate(-1)}>
                  Cancel
                </Button>
              </div>

              {execute.isError && (
                <p className="text-danger text-sm mt-2">
                  {execute.error instanceof Error ? execute.error.message : 'Purchase failed'}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
