// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  CheckCircle2,
  Globe,
  Loader2,
  Search,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  AlertTriangle,
  Euro,
  Upload,
} from 'lucide-react';
import {
  runSample,
  importPortfolio,
  getOnboardingState,
  updateOnboardingState,
  type SampleRunResult,
  type PortfolioImportResponse,
  type PortfolioImportDomain,
} from '@/api/onboarding';
import { scoreDomain, type ScoreResponse } from '@/api/score';
import { fetchUsageHistory } from '@/api/usage';
import { createDevice, fetchPushStatus, subscribePush, type PushStatus } from '@/api/mobile';
import { IS_STORE_BUILD, getStoredDeviceToken, storeDeviceToken } from '@/api/client';
import { toApplicationServerKey } from '@/lib/web-push';
import { SavingsCallout } from '@/components/SavingsCallout';
import { ScoreGauge } from '@/components/ScoreGauge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The mobile activation contract: three mandatory steps that produce a first
 * score, a real portfolio import and an explicit alert decision (ADR-0117).
 * There is deliberately no skip button: the funnel targets only mean
 * something if every new workspace walks the same path.
 */
const STEPS = [
  { id: 'score', label: 'Score a domain', icon: Search },
  { id: 'import', label: 'Import portfolio', icon: Upload },
  { id: 'alerts', label: 'Turn on alerts', icon: Bell },
] as const;

type StepId = (typeof STEPS)[number]['id'];

const EVIDENCE_NOTE = 'Estimate, not an appraisal or investment advice. Verify before you spend.';

interface ImportFormData {
  domains: string;
  renewalCost: string;
}

function SignalStatus({ signals }: { signals: ScoreResponse['score']['signalStatus'] }) {
  if (!signals || signals.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Evidence availability">
      {signals.map((signal) => (
        <li
          key={signal.name}
          className={cn(
            'rounded-full border px-3 py-1 text-xs',
            signal.available ? 'border-success/40 text-success' : 'border-border text-text-muted',
          )}
        >
          {signal.name}: {signal.available ? 'available' : 'not available'}
        </li>
      ))}
    </ul>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<StepId>('score');
  const [completed, setCompleted] = useState(false);
  const [loading, setLoading] = useState(true);

  const [domainInput, setDomainInput] = useState('');
  const [scoreResult, setScoreResult] = useState<ScoreResponse | null>(null);
  const [sampleResults, setSampleResults] = useState<SampleRunResult[] | null>(null);
  const [scoreLoading, setScoreLoading] = useState(false);
  const [scoreError, setScoreError] = useState<string | null>(null);

  const [importData, setImportData] = useState<ImportFormData>({ domains: '', renewalCost: '12' });
  const [importResult, setImportResult] = useState<PortfolioImportResponse | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [topics, setTopics] = useState({ renewal: true, watchlist: true, verdict: true });
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);

  // Paywall is shown as a fact about the user's own list, never as a generic
  // upgrade banner. Store builds have no prices or checkout (ADR-0114).
  const { data: usageHistory } = useQuery({
    queryKey: ['usage', 'history', 1],
    queryFn: () => fetchUsageHistory(1),
    staleTime: 60_000,
    retry: false,
  });
  const { data: pushStatus } = useQuery<PushStatus>({
    queryKey: ['mobile', 'push'],
    queryFn: fetchPushStatus,
    retry: false,
  });
  const domainsLimit = usageHistory?.[0]?.usage?.domains_tracked?.limitValue ?? null;
  const outsidePlan =
    importResult !== null && domainsLimit !== null
      ? Math.max(0, importResult.imported - domainsLimit)
      : 0;

  useEffect(() => {
    getOnboardingState()
      .then((state) => {
        if (state.completedAt) {
          setCompleted(true);
          return;
        }
        const step = state.currentStep as StepId;
        if (STEPS.some((s) => s.id === step)) setCurrentStep(step);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const goToStep = useCallback(async (step: StepId) => {
    setCurrentStep(step);
    await updateOnboardingState(step).catch(() => {});
  }, []);

  const handleScore = useCallback(async () => {
    const domain = domainInput.trim();
    if (!domain) return;
    setScoreLoading(true);
    setScoreError(null);
    try {
      const result = await scoreDomain(domain);
      setScoreResult(result);
      setSampleResults(null);
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : 'Could not score that domain');
    } finally {
      setScoreLoading(false);
    }
  }, [domainInput]);

  const handleSample = useCallback(async () => {
    setScoreLoading(true);
    setScoreError(null);
    try {
      const result = await runSample();
      setSampleResults(result.results);
      setScoreResult(null);
    } catch {
      setScoreError('Sample scoring is unavailable. Enter a domain above to try a real score.');
    } finally {
      setScoreLoading(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    setImportLoading(true);
    setImportError(null);

    const lines = importData.domains
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const renewalCost = Number(importData.renewalCost) || 12;
    const now = new Date().toISOString();
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const domains: PortfolioImportDomain[] = lines.map((domain) => ({
      domain: domain.toLowerCase(),
      tld: domain.includes('.') ? `.${domain.split('.').pop()}` : '.com',
      acquiredAt: now,
      renewalDate: nextYear,
      acquisitionCost: 0,
      renewalCost,
      registrar: 'manual',
    }));

    try {
      setImportResult(await importPortfolio(domains));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportLoading(false);
    }
  }, [importData]);

  const complete = useCallback(
    async (pushEnabled: boolean) => {
      await updateOnboardingState('complete', {
        completedAt: new Date().toISOString(),
        firstScore: scoreResult?.domain ?? 'sample',
        portfolioImported: importResult?.imported ?? 0,
        pushEnabled,
      }).catch(() => {});
      setCompleted(true);
      navigate('/', { replace: true });
    },
    [navigate, scoreResult, importResult],
  );

  const handleEnableAlerts = useCallback(async () => {
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      if (!getStoredDeviceToken()) storeDeviceToken((await createDevice('This device')).token);
      if (pushStatus?.enabled && 'serviceWorker' in navigator && 'PushManager' in window) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) throw new Error('Reload the page once to enable notifications');
        const key = pushStatus.vapidPublicKey;
        if (!key) throw new Error('Push is not configured on this server');
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: toApplicationServerKey(key),
        });
        const json = subscription.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
          throw new Error('The browser did not return a complete subscription');
        }
        await subscribePush({
          platform: 'web',
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
          deviceToken: getStoredDeviceToken()!,
          topics,
        });
      }
      await complete(true);
    } catch (err) {
      setAlertsError(
        err instanceof Error
          ? `${err.message} You can finish without notifications.`
          : 'Notifications are unavailable. You can finish without them.',
      );
    } finally {
      setAlertsLoading(false);
    }
  }, [pushStatus, topics, complete]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      </div>
    );
  }

  if (completed) return null;

  const currentIndex = STEPS.findIndex((step) => step.id === currentStep);
  const progressPct = (currentIndex / (STEPS.length - 1)) * 100;

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-8">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-bold text-text-primary">Get Started</h1>
        <p className="text-text-muted">Score, import and set alerts in 3 steps</p>
      </div>

      <div className="relative">
        <div className="absolute top-4 left-6 right-6 h-0.5 bg-bg-muted">
          <div
            className="h-full bg-brand-500 transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="flex justify-between relative">
          {STEPS.map((step, i) => (
            <div key={step.id} className="flex flex-col items-center gap-2">
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-medium transition-all duration-300',
                  i <= currentIndex
                    ? 'border-brand-500 bg-brand-500 text-white'
                    : 'border-border bg-bg-elevated text-text-muted',
                )}
              >
                {i < currentIndex ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <step.icon className="h-4 w-4" />
                )}
              </div>
              <span
                className={cn(
                  'whitespace-nowrap text-xs',
                  i <= currentIndex ? 'font-medium text-text-primary' : 'text-text-muted',
                )}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <Card className="border-border/50">
        <CardContent className="pt-6">
          {currentStep === 'score' && (
            <div className="space-y-6">
              <div className="space-y-2 text-center">
                <Search className="mx-auto h-10 w-10 text-brand-400" />
                <h2 className="text-xl font-semibold text-text-primary">Score a domain</h2>
                <p className="mx-auto max-w-md text-sm text-text-muted">
                  One domain, one decision: buy or pass. Every estimate shows the evidence behind it
                  — never an appraisal.
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="onboarding-domain" className="block text-sm font-medium">
                  Domain to score
                </label>
                <div className="flex gap-3">
                  <input
                    id="onboarding-domain"
                    value={domainInput}
                    onChange={(event) => setDomainInput(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && void handleScore()}
                    placeholder="vintagecoffee.com"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                  />
                  <Button
                    onClick={() => void handleScore()}
                    disabled={scoreLoading || !domainInput.trim()}
                  >
                    {scoreLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Score'}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleSample()}
                  disabled={scoreLoading}
                >
                  <Sparkles className="mr-2 h-3.5 w-3.5" /> Use sample data instead
                </Button>
              </div>

              {scoreError && (
                <p className="flex items-center gap-2 text-sm text-danger" role="alert">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> {scoreError}
                </p>
              )}

              {scoreResult && (
                <div className="space-y-3 rounded-lg border border-border bg-bg-elevated p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-text-primary">{scoreResult.domain}</span>
                    <span className="font-mono text-sm text-accent">
                      €{scoreResult.score.expectedValue.toFixed(0)}{' '}
                      <span className="text-xs text-text-muted">estimate</span>
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <ScoreGauge label="Confidence" value={scoreResult.score.confidence} />
                    <ScoreGauge label="Weighted Score" value={scoreResult.score.weightedScore} />
                  </div>
                  <SignalStatus signals={scoreResult.score.signalStatus} />
                  <p className="text-[11px] text-text-muted" role="note">
                    {EVIDENCE_NOTE}
                  </p>
                </div>
              )}

              {sampleResults && (
                <div className="space-y-2">
                  {sampleResults.map((sample) => (
                    <div
                      key={sample.domain}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-4 py-3 text-sm"
                    >
                      <span className="text-text-primary">{sample.domain}</span>
                      <span className="font-mono text-xs text-accent">
                        €{sample.score.expectedValue.toFixed(0)} estimate
                      </span>
                    </div>
                  ))}
                  <p className="text-[11px] text-text-muted" role="note">
                    {EVIDENCE_NOTE}
                  </p>
                </div>
              )}

              <div className="flex justify-end pt-2">
                <Button
                  onClick={() => void goToStep('import')}
                  disabled={!scoreResult && !sampleResults}
                >
                  Next: Import portfolio <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {currentStep === 'import' && (
            <div className="space-y-6">
              <div className="space-y-2 text-center">
                <Upload className="mx-auto h-10 w-10 text-brand-400" />
                <h2 className="text-xl font-semibold text-text-primary">Import your portfolio</h2>
                <p className="text-sm text-text-muted">
                  Paste your domains (one per line) for a real keep/drop/reprice decision.
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label htmlFor="import-domains" className="mb-1.5 block text-sm font-medium">
                    Domains (one per line)
                  </label>
                  <textarea
                    id="import-domains"
                    value={importData.domains}
                    onChange={(event) =>
                      setImportData((prev) => ({ ...prev, domains: event.target.value }))
                    }
                    placeholder={'vintagecoffee.com\noldmaproom.net\ngreenharvest.io'}
                    rows={6}
                    className="w-full resize-none rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                  />
                </div>
                <div>
                  <label htmlFor="import-renewal-cost" className="mb-1.5 block text-sm font-medium">
                    Annual renewal cost per domain (€)
                  </label>
                  <input
                    id="import-renewal-cost"
                    type="number"
                    min={0}
                    value={importData.renewalCost}
                    onChange={(event) =>
                      setImportData((prev) => ({ ...prev, renewalCost: event.target.value }))
                    }
                    className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                  />
                </div>
              </div>

              {importError && (
                <p className="flex items-center gap-2 text-sm text-danger" role="alert">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> {importError}
                </p>
              )}

              {importResult === null ? (
                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => void goToStep('score')}>
                    <ArrowLeft className="mr-2 h-4 w-4" /> Back
                  </Button>
                  <Button
                    onClick={() => void handleImport()}
                    disabled={importLoading || !importData.domains.trim()}
                  >
                    {importLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        Analyze Portfolio <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="space-y-5">
                  <SavingsCallout
                    annualSavingsEur={importResult.summary.annualSavingsEur}
                    droppedDomains={importResult.summary.drop}
                  />
                  <div className="grid grid-cols-3 gap-3">
                    {(
                      [
                        ['Keep', importResult.summary.keep, 'text-success'],
                        ['Reprice', importResult.summary.reprice, 'text-warning'],
                        ['Drop', importResult.summary.drop, 'text-danger'],
                      ] as const
                    ).map(([label, value, accent]) => (
                      <Card key={label}>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-xs uppercase tracking-wider text-text-muted">
                            {label}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <span className={cn('text-2xl font-bold', accent)}>{value}</span>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                  {!IS_STORE_BUILD && outsidePlan > 0 && (
                    <div className="rounded-lg border border-brand-500/40 bg-bg-elevated p-4 text-sm">
                      <p className="font-medium text-text-primary">
                        {outsidePlan} of your {importResult.imported} domains are outside the free
                        workspace.
                      </p>
                      <p className="mt-1 text-text-muted">
                        The verdicts are real. Pro keeps the whole renewal clock and history in one
                        place.
                      </p>
                      <Link
                        to="/billing"
                        className="mt-3 inline-flex items-center gap-1 text-brand-400 hover:underline"
                      >
                        See plans <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </Link>
                    </div>
                  )}
                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    {importResult.verdicts.map((verdict) => (
                      <div
                        key={verdict.domain}
                        className="flex items-center justify-between rounded-lg border border-border/50 bg-bg-elevated px-4 py-2.5 text-sm"
                      >
                        <span className="text-text-primary">{verdict.domain}</span>
                        <span className="font-mono text-xs text-text-muted">
                          €{verdict.expectedValue.toFixed(0)} · {verdict.verdict}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between pt-2">
                    <Button variant="ghost" onClick={() => void goToStep('score')}>
                      <ArrowLeft className="mr-2 h-4 w-4" /> Back
                    </Button>
                    <Button onClick={() => void goToStep('alerts')}>
                      Next: Turn on alerts <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {currentStep === 'alerts' && (
            <div className="space-y-6">
              <div className="space-y-2 text-center">
                <Bell className="mx-auto h-10 w-10 text-brand-400" />
                <h2 className="text-xl font-semibold text-text-primary">Turn on alerts</h2>
                <p className="mx-auto max-w-md text-sm text-text-muted">
                  Renewal dates and verdicts reach you here. Notifications are optional; this
                  decision is not skippable.
                </p>
              </div>

              {pushStatus?.enabled === false && (
                <p className="rounded-lg border border-border bg-bg-elevated p-3 text-sm text-text-muted">
                  Push is not configured on this server. Your alerts stay available in the Alerts
                  tab.
                </p>
              )}
              {pushStatus?.enabled === true && (
                <fieldset className="flex flex-wrap gap-4 text-sm">
                  <legend className="sr-only">Alert topics</legend>
                  {(['renewal', 'watchlist', 'verdict'] as const).map((topic) => (
                    <label key={topic} className="flex items-center gap-2 capitalize">
                      <input
                        type="checkbox"
                        checked={topics[topic]}
                        onChange={(event) =>
                          setTopics((current) => ({ ...current, [topic]: event.target.checked }))
                        }
                      />
                      {topic}
                    </label>
                  ))}
                </fieldset>
              )}
              {alertsError && (
                <p className="flex items-center gap-2 text-sm text-warning" role="status">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> {alertsError}
                </p>
              )}

              <div className="flex flex-wrap justify-between gap-3 pt-2">
                <Button variant="ghost" onClick={() => void goToStep('import')}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    onClick={() => void complete(false)}
                    disabled={alertsLoading}
                  >
                    Continue without notifications
                  </Button>
                  <Button onClick={() => void handleEnableAlerts()} disabled={alertsLoading}>
                    {alertsLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Globe className="mr-2 h-4 w-4" /> Enable notifications
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-text-muted">
        <Euro className="mr-1 inline h-3 w-3" />
        Estimates, not appraisals. Verify before you spend.
      </p>
    </div>
  );
}
