// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  useAdminOverview,
  useAdminTenants,
  useAdminTenantUsage,
  useSuspendTenant,
  useUnsuspendTenant,
  useSetPlanOverride,
} from '@/hooks/useAdmin';
import type { AdminPlan } from '@/api/admin';

const usageColumns = ['candidates_scored', 'api_calls', 'domains_tracked'] as const;
const PLAN_OPTIONS: AdminPlan[] = ['free', 'pro', 'team', 'enterprise'];
const DAYS_OPTIONS = [7, 14, 30, 90];

function formatUsage(used: number | undefined, limit: number | null | undefined): string {
  const usedText = String(used ?? 0);
  if (limit === null || limit === undefined) return usedText;
  return `${usedText} / ${limit}`;
}

interface SuspendFormProps {
  tenantId: string;
  onCancel: () => void;
  onConfirm: (reason: string | null) => void;
  pending: boolean;
}

function SuspendForm({ tenantId, onCancel, onConfirm, pending }: SuspendFormProps) {
  const [reason, setReason] = useState('');
  return (
    <div className="flex items-center gap-2">
      <input
        data-testid={`suspend-reason-${tenantId}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        className="h-8 rounded-md border border-border bg-bg-hover px-2 text-xs w-48"
      />
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => onConfirm(reason.trim() || null)}
      >
        Confirm
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

interface TenantRowProps {
  tenant: {
    tenantId: string;
    plan: AdminPlan;
    status: string;
    apiKeyCount: number;
    lastActiveAt: string | null;
    suspended: boolean;
    usage: { feature: (typeof usageColumns)[number]; used: number; limit: number | null }[];
  };
}

function TenantRow({ tenant }: TenantRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [days, setDays] = useState(14);
  const [suspendOpen, setSuspendOpen] = useState(false);

  const suspend = useSuspendTenant();
  const unsuspend = useUnsuspendTenant();
  const setOverride = useSetPlanOverride();
  const usageSeries = useAdminTenantUsage(tenant.tenantId, expanded ? days : 0);

  const usage = Object.fromEntries(tenant.usage.map((u) => [u.feature, u]));

  return (
    <>
      <tr className="border-t border-border">
        <td className="py-3 px-4">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{tenant.tenantId}</span>
            {tenant.suspended && (
              <Badge data-testid={`suspended-badge-${tenant.tenantId}`} variant="danger">
                suspended
              </Badge>
            )}
          </div>
        </td>
        <td className="py-3 px-4 text-sm capitalize">{tenant.plan}</td>
        <td className="py-3 px-4 text-sm capitalize">{tenant.status}</td>
        <td className="py-3 px-4 text-sm font-mono">{tenant.apiKeyCount}</td>
        <td className="py-3 px-4 text-sm text-text-muted">
          {tenant.lastActiveAt ? new Date(tenant.lastActiveAt).toLocaleString() : '—'}
        </td>
        {usageColumns.map((feature) => (
          <td key={feature} className="py-3 px-4 text-sm font-mono">
            {formatUsage(usage[feature]?.used, usage[feature]?.limit)}
          </td>
        ))}
        <td className="py-3 px-4">
          {tenant.suspended ? (
            <Button
              size="sm"
              variant="success"
              disabled={unsuspend.isPending}
              onClick={() => unsuspend.mutate(tenant.tenantId)}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Restore
            </Button>
          ) : suspendOpen ? (
            <SuspendForm
              tenantId={tenant.tenantId}
              pending={suspend.isPending}
              onCancel={() => setSuspendOpen(false)}
              onConfirm={(reason) => {
                suspend.mutate({ tenantId: tenant.tenantId, reason });
                setSuspendOpen(false);
              }}
            />
          ) : (
            <Button size="sm" variant="outline" onClick={() => setSuspendOpen(true)}>
              <ShieldAlert className="h-3.5 w-3.5" />
              Suspend
            </Button>
          )}
        </td>
        <td className="py-3 px-4">
          <select
            data-testid={`plan-override-${tenant.tenantId}`}
            value=""
            onChange={(e) => {
              const value = e.target.value;
              setOverride.mutate({
                tenantId: tenant.tenantId,
                plan: value === '' ? null : (value as AdminPlan),
              });
            }}
            className="h-8 rounded-md border border-border bg-bg-hover px-2 text-xs"
          >
            <option value="">Override…</option>
            {PLAN_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </td>
        <td className="py-3 px-4">
          <Button
            size="sm"
            variant="ghost"
            data-testid={`usage-toggle-${tenant.tenantId}`}
            onClick={() => {
              setExpanded((v) => !v);
            }}
          >
            {expanded ? 'Hide usage' : 'Usage'}
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-border bg-bg-muted">
          <td colSpan={11} className="py-3 px-4">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs font-medium text-text-muted">Daily usage</span>
              <select
                data-testid={`usage-days-${tenant.tenantId}`}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="h-8 rounded-md border border-border bg-bg-hover px-2 text-xs"
              >
                {DAYS_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    last {d} days
                  </option>
                ))}
              </select>
            </div>
            {usageSeries.isLoading ? (
              <Skeleton className="h-16 w-full rounded-lg" />
            ) : usageSeries.data && usageSeries.data.length > 0 ? (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-text-muted uppercase tracking-wider">
                    <th className="py-1 pr-4">Date</th>
                    <th className="py-1 pr-4">Feature</th>
                    <th className="py-1">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {usageSeries.data.map((point) => (
                    <tr key={`${point.date}-${point.feature}`} className="border-t border-border">
                      <td className="py-1 pr-4 font-mono">{point.date}</td>
                      <td className="py-1 pr-4">{point.feature}</td>
                      <td className="py-1 font-mono">{point.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-text-muted">No usage recorded in this window.</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function AdminPage() {
  const overview = useAdminOverview();
  const tenants = useAdminTenants();

  if (overview.isLoading || tenants.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (overview.error || tenants.error) {
    const message =
      overview.error instanceof Error ? overview.error.message : 'Failed to load admin data';
    return (
      <div className="space-y-6">
        <PageHeader title="Admin" subtitle="Platform administration (DOMINUS Cloud)" />
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <ShieldAlert className="h-8 w-8 text-danger" />
            <p className="text-danger text-sm">{message}</p>
            <p className="text-text-muted text-xs">
              This view requires an admin API key. Create one with the CLI key-management command.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = overview.data!;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin"
        subtitle={`Platform overview — period ${data.periodStart} to ${data.periodEnd}`}
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Tenants</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.tenantsCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active subs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-success">
              {data.activeSubscriptions}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Paid plans</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-brand-300">{data.paidPlans}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Candidates scored</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.candidatesScoredTotal}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>API calls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.apiCallsTotal}</div>
          </CardContent>
        </Card>
      </div>

      {tenants.data!.length === 0 ? (
        <EmptyState title="No tenants" description="No tenant activity has been recorded yet." />
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full min-w-[1100px]">
            <thead>
              <tr className="bg-bg-muted">
                {[
                  'Tenant',
                  'Plan',
                  'Status',
                  'Keys',
                  'Last active',
                  'Candidates',
                  'API calls',
                  'Domains',
                  'Actions',
                  'Plan override',
                  'Usage',
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-bg-elevated">
              {tenants.data!.map((t) => (
                <TenantRow key={t.tenantId} tenant={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
