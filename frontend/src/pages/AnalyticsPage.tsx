import { useState, useEffect, useCallback } from 'react';
import { fetchPnlReport, fetchAccuracyReport, refreshAccuracy } from '../api/analytics.js';
import type { PnlReport, AccuracyReport } from '../types/domain.js';

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-1 font-mono ${accent ?? 'text-gray-100'}`}>
        {value}
      </div>
    </div>
  );
}

function PnlSection({ report }: { report: PnlReport }) {
  const s = report.summary;
  const netColor = s.netPnlEur >= 0 ? 'text-emerald-400' : 'text-red-400';
  const roiColor = s.roiPct >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
        Portfolio P&amp;L
      </h3>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Investment" value={`\u20AC${s.totalInvestmentEur.toFixed(2)}`} />
        <StatCard
          label="Total Returns"
          value={`\u20AC${s.totalReturnsEur.toFixed(2)}`}
          accent="text-emerald-400"
        />
        <StatCard label="Net P&amp;L" value={`\u20AC${s.netPnlEur.toFixed(2)}`} accent={netColor} />
        <StatCard
          label="ROI"
          value={`${s.roiPct >= 0 ? '+' : ''}${s.roiPct.toFixed(1)}%`}
          accent={roiColor}
        />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Holding Costs" value={`\u20AC${s.holdingCostsEur.toFixed(2)}`} />
        <StatCard label="Portfolio Size" value={String(s.totalCount)} />
        <StatCard label="Sold" value={String(s.soldCount)} />
        <StatCard
          label="Avg Sale Price"
          value={
            s.soldCount > 0 ? `\u20AC${(s.totalReturnsEur / s.soldCount).toFixed(2)}` : '\u2014'
          }
        />
      </div>
    </div>
  );
}

function PerDomainTable({ report }: { report: PnlReport }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
        Per-Domain Breakdown
      </h3>
      {report.perDomain.length === 0 ? (
        <p className="text-sm text-gray-500">No portfolio entries found.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900">
              <tr className="text-left text-gray-500 text-xs uppercase">
                <th className="py-3 px-4">Domain</th>
                <th className="py-3 px-4">TLD</th>
                <th className="py-3 px-4">Cost</th>
                <th className="py-3 px-4">Renewals</th>
                <th className="py-3 px-4">Total Cost</th>
                <th className="py-3 px-4">Sale Price</th>
                <th className="py-3 px-4">Net P&amp;L</th>
                <th className="py-3 px-4">Holding</th>
                <th className="py-3 px-4">Verdict</th>
              </tr>
            </thead>
            <tbody className="bg-gray-950">
              {report.perDomain.map((d) => {
                const pnlColor =
                  d.netPnlEur > 0
                    ? 'text-emerald-400'
                    : d.netPnlEur < 0
                      ? 'text-red-400'
                      : 'text-gray-400';
                const verdictClass =
                  d.verdict === 'keep'
                    ? 'text-emerald-400'
                    : d.verdict === 'drop'
                      ? 'text-red-400'
                      : 'text-amber-400';
                return (
                  <tr key={d.domain} className="border-b border-gray-800">
                    <td className="py-3 px-4 font-medium text-gray-200">{d.domain}</td>
                    <td className="py-3 px-4 text-gray-400">{d.tld}</td>
                    <td className="py-3 px-4 font-mono text-gray-300">
                      \u20AC{d.acquisitionCostEur.toFixed(2)}
                    </td>
                    <td className="py-3 px-4 font-mono text-gray-300">
                      \u20AC{d.renewalCostsPaidEur.toFixed(2)}
                    </td>
                    <td className="py-3 px-4 font-mono text-gray-300">
                      \u20AC{d.totalCostEur.toFixed(2)}
                    </td>
                    <td className="py-3 px-4 font-mono text-gray-300">
                      {d.salePriceEur != null ? `\u20AC${d.salePriceEur.toFixed(2)}` : '\u2014'}
                    </td>
                    <td className={`py-3 px-4 font-mono ${pnlColor}`}>
                      {d.netPnlEur >= 0 ? '+' : ''}\u20AC{d.netPnlEur.toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-gray-400">{d.holdingDays}d</td>
                    <td className={`py-3 px-4 font-medium ${verdictClass}`}>{d.verdict}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MonthlyTrendChart({ report }: { report: PnlReport }) {
  if (report.monthlyTrend.length === 0) return null;

  const maxAbs = Math.max(...report.monthlyTrend.map((m) => Math.max(Math.abs(m.netFlowEur), 1)));

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
        Monthly Cash Flow
      </h3>
      <div className="overflow-x-auto rounded-xl border border-gray-800 p-4 bg-gray-900">
        <div className="flex items-end gap-3 min-w-[300px]">
          {report.monthlyTrend.map((m) => {
            const heightPct = (Math.abs(m.netFlowEur) / maxAbs) * 100;
            const isPositive = m.netFlowEur >= 0;
            return (
              <div key={m.period} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-xs font-mono text-gray-500">
                  {m.netFlowEur >= 0 ? '+' : ''}\u20AC{m.netFlowEur.toFixed(0)}
                </span>
                <div className="w-full flex flex-col items-center" style={{ height: 120 }}>
                  {isPositive ? (
                    <div
                      className="w-full bg-emerald-600/60 rounded-t"
                      style={{ height: `${heightPct}%`, minHeight: 4 }}
                    />
                  ) : (
                    <div
                      className="w-full bg-red-600/60 rounded-b mt-auto"
                      style={{ height: `${heightPct}%`, minHeight: 4 }}
                    />
                  )}
                </div>
                <span className="text-xs text-gray-500">{m.period}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AccuracySection({ report }: { report: AccuracyReport }) {
  const o = report.overall;
  const cm = report.confusionMatrix;

  if (report.sampleSize === 0) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Prediction Accuracy
        </h3>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 text-center">
          <p className="text-sm text-gray-500">
            No outcome data recorded yet. Record outcomes first, then run
            <code className="mx-1 text-cyan-400">dominus analytics refresh</code> to generate
            accuracy metrics.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
        Prediction Accuracy
      </h3>

      {report.warnings.length > 0 && (
        <div className="bg-amber-950/40 border border-amber-900/50 text-amber-400 px-4 py-2 rounded-lg text-xs">
          {report.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Sample Size" value={String(o.sampleSize)} />
        <StatCard label="MAE" value={`\u20AC${o.mae.toFixed(2)}`} />
        <StatCard label="MAPE" value={`${o.mape.toFixed(1)}%`} />
        <StatCard
          label="Bias"
          value={`${o.biasPct >= 0 ? '+' : ''}${o.biasPct.toFixed(1)}%`}
          accent={
            o.biasPct > 5 ? 'text-red-400' : o.biasPct < -5 ? 'text-red-400' : 'text-emerald-400'
          }
        />
      </div>

      {report.sampleSize > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">
                Confusion Matrix
              </h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-gray-500">TP:</span>{' '}
                  <span className="font-mono text-emerald-400">{cm.truePositives}</span>
                </div>
                <div>
                  <span className="text-gray-500">FP:</span>{' '}
                  <span className="font-mono text-red-400">{cm.falsePositives}</span>
                </div>
                <div>
                  <span className="text-gray-500">TN:</span>{' '}
                  <span className="font-mono text-gray-300">{cm.trueNegatives}</span>
                </div>
                <div>
                  <span className="text-gray-500">FN:</span>{' '}
                  <span className="font-mono text-amber-400">{cm.falseNegatives}</span>
                </div>
              </div>
            </div>
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">
                Quality Metrics
              </h4>
              <div className="space-y-1 text-sm">
                <div>
                  <span className="text-gray-500">Precision:</span>{' '}
                  <span className="font-mono text-gray-200">
                    {(cm.precision * 100).toFixed(1)}%
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Recall:</span>{' '}
                  <span className="font-mono text-gray-200">{(cm.recall * 100).toFixed(1)}%</span>
                </div>
                <div>
                  <span className="text-gray-500">F1 Score:</span>{' '}
                  <span className="font-mono text-gray-200">{(cm.f1 * 100).toFixed(1)}%</span>
                </div>
              </div>
            </div>
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Calibration</h4>
              <div className="space-y-1 text-sm">
                {Object.entries(report.calibration).map(([bucket, data]) => (
                  <div key={bucket}>
                    <span className="text-gray-500 capitalize">{bucket}:</span>{' '}
                    <span className="font-mono text-gray-200">
                      n={data.n}
                      {data.n > 0 ? ` MAE=\u20AC${data.meanAbsError.toFixed(0)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function AnalyticsPage() {
  const [pnlReport, setPnlReport] = useState<PnlReport | null>(null);
  const [accuracyReport, setAccuracyReport] = useState<AccuracyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'pnl' | 'accuracy'>('pnl');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pnl, acc] = await Promise.all([
        fetchPnlReport().catch(() => null),
        fetchAccuracyReport().catch(() => null),
      ]);
      setPnlReport(pnl);
      setAccuracyReport(acc);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAccuracy();
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [loadAll]);

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-100">Analytics</h2>
        </div>
        <div className="bg-red-950/50 border border-red-900 text-red-400 px-4 py-6 rounded-xl text-center">
          <p className="text-sm mb-4">{error}</p>
          <button
            onClick={loadAll}
            className="px-4 py-2 bg-red-800 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-100">Analytics</h2>
          <p className="text-sm text-gray-500 mt-1">
            Portfolio performance &amp; prediction accuracy
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-3 py-1.5 bg-cyan-800 hover:bg-cyan-700 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-lg text-xs font-medium transition-colors"
        >
          {refreshing ? 'Refreshing...' : '\u21BB Refresh Accuracy'}
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
        {(['pnl', 'accuracy'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              tab === t
                ? 'bg-cyan-900/40 text-cyan-300'
                : 'bg-gray-900 text-gray-400 hover:text-gray-200'
            }`}
          >
            {t === 'pnl' ? 'P&amp;L' : 'Accuracy'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-gray-500 animate-pulse py-8 text-center">Loading analytics...</div>
      ) : (
        <>
          {tab === 'pnl' && pnlReport && (
            <div className="space-y-6">
              <PnlSection report={pnlReport} />
              <MonthlyTrendChart report={pnlReport} />
              <PerDomainTable report={pnlReport} />
            </div>
          )}
          {tab === 'accuracy' && accuracyReport && <AccuracySection report={accuracyReport} />}
          {tab === 'pnl' && !pnlReport && (
            <div className="text-gray-600 text-sm py-8 text-center">
              P&amp;L data not available. Add portfolio entries to see your P&amp;L.
            </div>
          )}
        </>
      )}
    </div>
  );
}
