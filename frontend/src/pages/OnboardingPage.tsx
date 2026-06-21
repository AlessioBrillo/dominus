import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles,
  Upload,
  BarChart3,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Globe,
  AlertTriangle,
  Euro,
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
import { SavingsCallout } from '@/components/SavingsCallout';
import { ScoreGauge } from '@/components/ScoreGauge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const STEPS = [
  { id: 'welcome', label: 'Welcome', icon: Sparkles },
  { id: 'sample-run', label: 'See it in action', icon: BarChart3 },
  { id: 'import', label: 'Import portfolio', icon: Upload },
  { id: 'results', label: 'Your verdicts', icon: CheckCircle2 },
] as const;

type StepId = (typeof STEPS)[number]['id'];

interface ImportFormData {
  domains: string;
  renewalCost: string;
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<StepId>('welcome');
  const [completed, setCompleted] = useState(false);
  const [loading, setLoading] = useState(true);

  const [sampleResults, setSampleResults] = useState<SampleRunResult[] | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);

  const [importData, setImportData] = useState<ImportFormData>({ domains: '', renewalCost: '12' });
  const [importResult, setImportResult] = useState<PortfolioImportResponse | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    getOnboardingState()
      .then((state) => {
        if (state.completedAt) {
          setCompleted(true);
          return;
        }
        const step = state.currentStep as StepId;
        if (STEPS.some((s) => s.id === step)) {
          setCurrentStep(step);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const goToStep = useCallback(async (step: StepId) => {
    setCurrentStep(step);
    await updateOnboardingState(step).catch(() => {});
  }, []);

  const handleSampleRun = useCallback(async () => {
    setSampleLoading(true);
    try {
      const result = await runSample();
      setSampleResults(result.results);
      await goToStep('import');
    } catch {
      setSampleResults([]);
    } finally {
      setSampleLoading(false);
    }
  }, [goToStep]);

  const handleImport = useCallback(async () => {
    setImportLoading(true);
    setImportError(null);

    const lines = importData.domains
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const renewalCost = Number(importData.renewalCost) || 12;
    const now = new Date().toISOString();
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const domains: PortfolioImportDomain[] = lines.map((domain) => {
      const tld = domain.includes('.') ? `.${domain.split('.').pop()}` : '.com';
      return {
        domain: domain.toLowerCase(),
        tld,
        acquiredAt: now,
        renewalDate: nextYear,
        acquisitionCost: 0,
        renewalCost,
        registrar: 'manual',
      };
    });

    try {
      const result = await importPortfolio(domains);
      setImportResult(result);
      await goToStep('results');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportLoading(false);
    }
  }, [importData, goToStep]);

  const handleComplete = useCallback(async () => {
    await updateOnboardingState('complete', { completedAt: new Date().toISOString() });
    setCompleted(true);
    navigate('/', { replace: true });
  }, [navigate]);

  const handleSkip = useCallback(async () => {
    await updateOnboardingState('complete', { skipped: true });
    setCompleted(true);
    navigate('/', { replace: true });
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      </div>
    );
  }

  if (completed) {
    return null;
  }

  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);
  const progressPct = (currentIndex / (STEPS.length - 1)) * 100;

  return (
    <div className="max-w-2xl mx-auto py-8 space-y-8">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold text-text-primary">Get Started</h1>
        <p className="text-text-muted">Set up DOMINUS for your domain portfolio in 3 steps</p>
      </div>

      <div className="relative">
        <div className="absolute top-4 left-6 right-6 h-0.5 bg-bg-muted">
          <div
            className="h-full bg-brand-500 transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="flex justify-between relative">
          {STEPS.map((step, i) => {
            const isActive = i <= currentIndex;
            return (
              <div key={step.id} className="flex flex-col items-center gap-2">
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium border-2 transition-all duration-300',
                    isActive
                      ? 'bg-brand-500 border-brand-500 text-white'
                      : 'bg-bg-elevated border-border text-text-muted',
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
                    'text-xs whitespace-nowrap',
                    isActive ? 'text-text-primary font-medium' : 'text-text-muted',
                  )}
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <Card className="border-border/50">
        <CardContent className="pt-6">
          {currentStep === 'welcome' && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <Globe className="h-12 w-12 text-brand-400 mx-auto" />
                <h2 className="text-xl font-semibold text-text-primary">Welcome to DOMINUS</h2>
                <p className="text-sm text-text-muted max-w-md mx-auto">
                  Your domain investment decision engine. Score domains, track your portfolio, and
                  get clear keep/drop verdicts with quantified savings.
                </p>
              </div>
              <div className="grid gap-4">
                <div className="flex items-start gap-3 p-4 rounded-lg bg-bg-elevated">
                  <BarChart3 className="h-5 w-5 text-brand-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">Score any domain</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      Get heuristic scores with trademark risk assessment in seconds.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-4 rounded-lg bg-bg-elevated">
                  <Upload className="h-5 w-5 text-brand-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">Import your portfolio</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      Paste a list of domains to get instant keep/drop/reprice verdicts.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-4 rounded-lg bg-bg-elevated">
                  <Euro className="h-5 w-5 text-success shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">Quantified savings</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      See exactly how much you save by dropping underperforming domains.
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={handleSkip} className="text-text-muted">
                  Skip setup
                </Button>
                <Button onClick={() => goToStep('sample-run')}>
                  Get Started
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          )}

          {currentStep === 'sample-run' && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h2 className="text-xl font-semibold text-text-primary">See it in action</h2>
                <p className="text-sm text-text-muted">
                  Run the scoring engine on sample domains to see what DOMINUS can do.
                </p>
              </div>

              {!sampleResults ? (
                <div className="text-center py-8">
                  <Button onClick={handleSampleRun} disabled={sampleLoading} size="lg">
                    {sampleLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Scoring...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4 mr-2" />
                        Run Sample
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {sampleResults.map((r) => (
                    <div
                      key={r.domain}
                      className="p-4 rounded-lg bg-bg-elevated border border-border/50"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <span className="text-sm font-medium text-text-primary">{r.domain}</span>
                          {r.trademark && (
                            <span
                              className={cn(
                                'ml-2 text-xs px-1.5 py-0.5 rounded',
                                r.trademark.verdict === 'clear'
                                  ? 'bg-success/10 text-success'
                                  : r.trademark.verdict === 'blocked'
                                    ? 'bg-danger/10 text-danger'
                                    : 'bg-warning/10 text-warning',
                              )}
                            >
                              {r.trademark.verdict}
                            </span>
                          )}
                        </div>
                        <span className="text-lg font-bold text-brand-400 font-mono">
                          {r.score.expectedValue.toFixed(0)}
                          <span className="text-xs text-text-muted font-normal"> EV</span>
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <ScoreGauge label="Confidence" value={r.score.confidence} />
                        <ScoreGauge label="Weighted Score" value={r.score.weightedScore} />
                      </div>
                    </div>
                  ))}
                  <div className="flex justify-between pt-2">
                    <Button variant="ghost" onClick={() => goToStep('welcome')}>
                      <ArrowLeft className="h-4 w-4 mr-2" />
                      Back
                    </Button>
                    <Button onClick={() => goToStep('import')}>
                      Next: Import Portfolio
                      <ArrowRight className="h-4 w-4 ml-2" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {currentStep === 'import' && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h2 className="text-xl font-semibold text-text-primary">Import your portfolio</h2>
                <p className="text-sm text-text-muted">
                  Paste your domain names (one per line) to get keep/drop verdicts with quantified
                  annual savings.
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">
                    Domains (one per line)
                  </label>
                  <textarea
                    value={importData.domains}
                    onChange={(e) =>
                      setImportData((prev) => ({ ...prev, domains: e.target.value }))
                    }
                    placeholder={`vintagecoffee.com
oldmaproom.net
greenharvest.io`}
                    rows={6}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-bg-elevated text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/50 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">
                    Annual renewal cost per domain (€)
                  </label>
                  <input
                    type="number"
                    value={importData.renewalCost}
                    onChange={(e) =>
                      setImportData((prev) => ({ ...prev, renewalCost: e.target.value }))
                    }
                    min={0}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-bg-elevated text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                  />
                </div>
              </div>

              {importError && (
                <div className="flex items-center gap-2 text-sm text-danger bg-danger/10 px-4 py-3 rounded-lg">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {importError}
                </div>
              )}

              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => goToStep('sample-run')}>
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  onClick={handleImport}
                  disabled={importLoading || !importData.domains.trim()}
                >
                  {importLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      Analyze Portfolio
                      <ArrowRight className="h-4 w-4 ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {currentStep === 'results' && importResult && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <CheckCircle2 className="h-10 w-10 text-success mx-auto" />
                <h2 className="text-xl font-semibold text-text-primary">Your Portfolio Analysis</h2>
                <p className="text-sm text-text-muted">{importResult.imported} domains analyzed</p>
              </div>

              <SavingsCallout
                annualSavingsEur={importResult.summary.annualSavingsEur}
                droppedDomains={importResult.summary.drop}
              />

              <div className="grid grid-cols-3 gap-3">
                <Card className="border-success/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-text-muted uppercase tracking-wider">
                      Keep
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-2xl font-bold text-success">
                      {importResult.summary.keep}
                    </span>
                  </CardContent>
                </Card>
                <Card className="border-warning/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-text-muted uppercase tracking-wider">
                      Reprice
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-2xl font-bold text-warning">
                      {importResult.summary.reprice}
                    </span>
                  </CardContent>
                </Card>
                <Card className="border-danger/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-text-muted uppercase tracking-wider">
                      Drop
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-2xl font-bold text-danger">
                      {importResult.summary.drop}
                    </span>
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto">
                {importResult.verdicts.map((v) => (
                  <div
                    key={v.domain}
                    className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-bg-elevated border border-border/50 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          v.verdict === 'keep'
                            ? 'bg-success'
                            : v.verdict === 'drop'
                              ? 'bg-danger'
                              : 'bg-warning',
                        )}
                      />
                      <span className="text-text-primary">{v.domain}</span>
                      {v.trademarkClear === false && (
                        <AlertTriangle className="h-3 w-3 text-warning" />
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs font-mono">
                      <span className="text-text-muted">EV: €{v.expectedValue.toFixed(0)}</span>
                      <span
                        className={cn(
                          'font-medium',
                          v.verdict === 'keep'
                            ? 'text-success'
                            : v.verdict === 'drop'
                              ? 'text-danger'
                              : 'text-warning',
                        )}
                      >
                        {v.verdict}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-4">
                <Button onClick={handleComplete} className="w-full" size="lg">
                  Go to Dashboard
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
