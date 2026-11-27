// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { api } from '@/api/client';
import { useAcknowledgeAlert, useAcknowledgeAllAlerts } from '@/hooks/useAlerts';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { Alert } from '@/types/domain';

/** Mobile-first alerts screen: one decision per card (ADR-0114). */
export function AlertsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['alerts', 'list'],
    queryFn: ({ signal }) => api.get<{ alerts: Alert[] }>('/alerts', signal),
  });

  const acknowledge = useAcknowledgeAlert();
  const acknowledgeAll = useAcknowledgeAllAlerts();

  const alerts = (data?.alerts ?? []).filter((alert) => !alert.acknowledgedAt);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alerts"
        subtitle="Renewal clock and portfolio decisions that need you"
        actions={
          alerts.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={acknowledgeAll.isPending}
              onClick={async () => {
                await acknowledgeAll.mutateAsync();
                await refetch();
              }}
            >
              <CheckCheck className="h-3.5 w-3.5 mr-1" />
              Dismiss all
            </Button>
          ) : undefined
        }
      />

      <p className="text-[11px] text-text-muted" role="note">
        Alerts come from your renewal clock and verdicts, not from an appraisal. Verify before you
        spend.
      </p>

      {isLoading && (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {error && (
        <p className="text-sm text-red-400" role="alert">
          Alerts could not be loaded. Try again in a moment.
        </p>
      )}

      {!isLoading && !error && alerts.length === 0 && (
        <EmptyState
          icon={<BellOff className="h-8 w-8" />}
          title="Nothing needs a decision"
          description="Renewal reminders and portfolio verdicts appear here."
        />
      )}

      {!isLoading && !error && alerts.length > 0 && (
        <ul className="space-y-3">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <Card>
                <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-start gap-3">
                    <Bell className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" />
                    <div>
                      <p className="text-sm font-medium text-text-primary">{alert.domain}</p>
                      <p className="text-xs text-text-muted">{alert.message}</p>
                      <p className="mt-1 text-[10px] uppercase tracking-wide text-text-muted">
                        {alert.severity}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={acknowledge.isPending}
                    onClick={async () => {
                      await acknowledge.mutateAsync(alert.id);
                      await refetch();
                    }}
                  >
                    Dismiss
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
