// SPDX-License-Identifier: AGPL-3.0-only
import { Play, RotateCcw } from 'lucide-react';
import {
  useAutomationAudit,
  useAutomationSettings,
  useAutomationSteps,
  useResetAutomation,
  useRunAutomation,
  useUpdateAutomationSettings,
} from '@/hooks/useAutomation';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { AutomationSettings, AutomationStepStatus } from '@/api/automation';

const stepStatusBadge: Record<AutomationStepStatus, string> = {
  pending: 'pending',
  done: 'completed',
  skipped: 'cancelled',
  failed: 'failed',
};

/** Accessible on/off toggle built from the button-group pattern used elsewhere. */
function Toggle({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-2" role="group" aria-label={label}>
      <Button
        variant={value ? 'default' : 'outline'}
        size="sm"
        aria-pressed={value}
        disabled={disabled}
        onClick={() => onChange(true)}
      >
        On
      </Button>
      <Button
        variant={!value ? 'default' : 'outline'}
        size="sm"
        aria-pressed={!value}
        disabled={disabled}
        onClick={() => onChange(false)}
      >
        Off
      </Button>
    </div>
  );
}

function effectiveSummary(settings: AutomationSettings): string {
  if (!settings.effective.enabled) {
    return settings.effective.refusedBy === 'tenant_switch'
      ? 'Refused: this tenant is opted out of automation.'
      : 'Refused: the operator kill switch is off, so no pipeline runs.';
  }
  return settings.effective.dryRun
    ? 'Effective: the pipeline runs and simulates every step — no money is spent and no DNS record is changed.'
    : 'Effective: the pipeline executes steps for real, including money and DNS actions.';
}

export function AutomationPage() {
  const { data, isLoading, error } = useAutomationSettings();
  const stepsQuery = useAutomationSteps();
  const auditQuery = useAutomationAudit();
  const updateSettings = useUpdateAutomationSettings();
  const runPipeline = useRunAutomation();
  const resetPipeline = useResetAutomation();

  const settings = data?.settings;
  const steps = stepsQuery.data?.steps ?? [];
  const audit = auditQuery.data?.entries ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Automation" subtitle="Post-acquisition pipeline (ADR-0083)" />

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center text-danger text-sm">
            {error instanceof Error ? error.message : 'Failed to load automation settings'}
          </CardContent>
        </Card>
      ) : settings ? (
        <>
          {!settings.global.enabled && (
            <div className="bg-warning/10 border border-warning/30 text-warning px-4 py-3 rounded-lg text-sm">
              The operator kill switch is off (AUTOMATION_ENABLED=false). Runs are refused
              regardless of this tenant's switch until the operator enables it.
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Tenant automation</CardTitle>
              <CardDescription>
                Your own switch for the automated lifecycle after a purchase: for-sale page,
                indexing, DNS, parking and marketplace listing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-text-primary">Automation</div>
                  <div className="text-xs text-text-muted">
                    Opt in to run the pipeline automatically after each purchase.
                  </div>
                </div>
                <Toggle
                  label="Automation"
                  value={settings.tenant.enabled}
                  disabled={updateSettings.isPending}
                  onChange={(enabled) => updateSettings.mutate({ enabled })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-text-primary">Dry-run</div>
                  <div className="text-xs text-text-muted">
                    Simulate the pipeline without spending money or touching DNS.
                  </div>
                </div>
                <Toggle
                  label="Dry-run"
                  value={settings.tenant.dryRun}
                  disabled={updateSettings.isPending}
                  onChange={(dryRun) => updateSettings.mutate({ dryRun })}
                />
              </div>
              <p className="text-xs text-text-muted border-t border-border pt-3">
                {effectiveSummary(settings)}
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Step journal</CardTitle>
          <CardDescription>
            One row per domain and step. A completed step is never re-run until reset.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stepsQuery.isLoading ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : steps.length === 0 ? (
            <EmptyState
              title="No pipeline steps yet"
              description="Steps appear here once a domain goes through the post-acquisition pipeline."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-2 font-medium">Domain</th>
                  <th className="py-2 font-medium">Step</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium">Attempts</th>
                  <th className="py-2 font-medium">Updated</th>
                  <th className="py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step) => (
                  <tr key={step.id} className="border-t border-border">
                    <td className="py-2 text-text-primary">{step.domain}</td>
                    <td className="py-2 text-text-secondary">{step.step}</td>
                    <td className="py-2">
                      <StatusBadge status={stepStatusBadge[step.status] ?? step.status} />
                    </td>
                    <td className="py-2 text-text-secondary">{step.attempts}</td>
                    <td className="py-2 text-text-muted">
                      {new Date(step.updatedAt).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => runPipeline.mutate(step.domain)}
                          disabled={runPipeline.isPending}
                          aria-label={`Run pipeline for ${step.domain}`}
                        >
                          <Play className="h-3.5 w-3.5 mr-1" />
                          Run
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => resetPipeline.mutate(step.domain)}
                          disabled={resetPipeline.isPending}
                          aria-label={`Reset pipeline for ${step.domain}`}
                        >
                          <RotateCcw className="h-3.5 w-3.5 mr-1" />
                          Reset
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit trail</CardTitle>
          <CardDescription>
            Every autonomous action the pipeline took, with its trigger source.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {auditQuery.isLoading ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : audit.length === 0 ? (
            <EmptyState
              title="No audit entries"
              description="Runs and step transitions are recorded here as they happen."
            />
          ) : (
            <ul className="space-y-2">
              {audit.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center gap-3 text-sm border-b border-border pb-2 last:border-0"
                >
                  <span className="text-text-muted text-xs whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <span className="text-text-primary font-mono text-xs">{entry.action}</span>
                  <span className="text-text-secondary">{entry.domain ?? '—'}</span>
                  <span className="text-text-muted text-xs ml-auto">{entry.actor}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
