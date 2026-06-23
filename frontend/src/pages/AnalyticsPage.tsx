import { RefreshCw } from 'lucide-react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { usePnlReport, useAccuracyReport } from '@/hooks/useAnalytics';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-text-primary">Analytics</h2>
      <Tabs defaultValue="pnl">
        <TabsList>
          <TabsTrigger value="pnl">P&L</TabsTrigger>
          <TabsTrigger value="accuracy">Accuracy</TabsTrigger>
        </TabsList>
        <TabsContent value="pnl">
          <PnlSection />
        </TabsContent>
        <TabsContent value="accuracy">
          <AccuracySection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function PnlSection() {
  const { data, isLoading, error, refetch } = usePnlReport();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-3 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-6 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="p-6">
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center py-8">
          <p className="text-danger text-sm mb-4">
            {error instanceof Error ? error.message : 'Failed to load P&L data'}
          </p>
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-text-muted">
          P&L data not available
        </CardContent>
      </Card>
    );
  }

  const s = data.summary;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Invested" value={`€${s.totalInvestmentEur.toFixed(0)}`} />
        <StatCard label="Total Returns" value={`€${s.totalReturnsEur.toFixed(0)}`} />
        <StatCard
          label="Net P&L"
          value={`€${s.netPnlEur.toFixed(0)}`}
          accent={s.netPnlEur >= 0 ? 'text-success' : 'text-danger'}
        />
        <StatCard
          label="ROI"
          value={`${s.roiPct.toFixed(1)}%`}
          accent={s.roiPct >= 0 ? 'text-success' : 'text-danger'}
        />
        <StatCard label="Domains Sold" value={String(s.soldCount)} />
        <StatCard label="Total Domains" value={String(s.totalCount)} />
        <StatCard label="Holding Costs" value={`€${s.holdingCostsEur.toFixed(0)}`} />
      </div>

      {data.monthlyTrend.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Monthly P&L Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.monthlyTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="period" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
                  <YAxis stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="investmentEur"
                    stroke="#ef4444"
                    strokeWidth={2}
                    dot={false}
                    name="Investment"
                  />
                  <Line
                    type="monotone"
                    dataKey="returnsEur"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    name="Returns"
                  />
                  <Line
                    type="monotone"
                    dataKey="netFlowEur"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    dot={false}
                    name="Net Flow"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {data.perDomain.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Per-Domain Performance</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-bg-muted">
                    {['Domain', 'Cost', 'Sale Price', 'Net P&L', 'Hold Days', 'Verdict'].map(
                      (h) => (
                        <th
                          key={h}
                          className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider"
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.perDomain.map((d) => (
                    <tr
                      key={d.domain}
                      className="border-b border-border hover:bg-bg-hover transition-colors"
                    >
                      <td className="py-3 px-4 font-mono text-sm text-text-primary">{d.domain}</td>
                      <td className="py-3 px-4 font-mono text-sm text-text-secondary">
                        €{d.totalCostEur.toFixed(0)}
                      </td>
                      <td className="py-3 px-4 font-mono text-sm text-success">
                        {d.salePriceEur != null ? `€${d.salePriceEur.toFixed(0)}` : '—'}
                      </td>
                      <td
                        className={`py-3 px-4 font-mono text-sm ${d.netPnlEur >= 0 ? 'text-success' : 'text-danger'}`}
                      >
                        €{d.netPnlEur.toFixed(0)}
                      </td>
                      <td className="py-3 px-4 text-sm text-text-secondary">{d.holdingDays}d</td>
                      <td className="py-3 px-4 text-sm text-text-secondary">{d.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function AccuracySection() {
  const { data, isLoading, error, refetch } = useAccuracyReport();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-3 w-20" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-6 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center py-8">
          <p className="text-danger text-sm mb-4">
            {error instanceof Error ? error.message : 'Failed to load accuracy data'}
          </p>
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-text-muted">
          No outcome data recorded yet. Use the CLI to record outcomes.
        </CardContent>
      </Card>
    );
  }

  const cm = data.confusionMatrix;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="MAPE" value={`${(data.overall.mape * 100).toFixed(1)}%`} />
        <StatCard label="Median APE" value={`${(data.overall.medianApe * 100).toFixed(1)}%`} />
        <StatCard label="MAE" value={`€${data.overall.mae.toFixed(0)}`} />
        <StatCard label="RMSE" value={`€${data.overall.rmse.toFixed(0)}`} />
        <StatCard
          label="Bias"
          value={`${(data.overall.biasPct * 100).toFixed(1)}%`}
          accent={Math.abs(data.overall.biasPct) < 0.1 ? 'text-success' : 'text-warning'}
        />
        <StatCard label="Sample Size" value={String(data.overall.sampleSize)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Confusion Matrix</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <div />
              <div className="text-text-muted text-xs font-medium">Predicted Yes</div>
              <div className="text-text-muted text-xs font-medium">Predicted No</div>
              <div className="text-text-muted text-xs font-medium text-left">Actual Yes</div>
              <div className="bg-success/20 rounded-lg p-3 font-mono text-success">
                {cm.truePositives}
              </div>
              <div className="bg-danger/20 rounded-lg p-3 font-mono text-danger">
                {cm.falseNegatives}
              </div>
              <div className="text-text-muted text-xs font-medium text-left">Actual No</div>
              <div className="bg-danger/20 rounded-lg p-3 font-mono text-danger">
                {cm.falsePositives}
              </div>
              <div className="bg-success/20 rounded-lg p-3 font-mono text-success">
                {cm.trueNegatives}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quality Metrics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <MetricBar label="Precision" value={cm.precision} />
            <MetricBar label="Recall" value={cm.recall} />
            <MetricBar label="F1 Score" value={cm.f1} />
          </CardContent>
        </Card>
      </div>

      {Object.keys(data.calibration).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Calibration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={Object.entries(data.calibration).map(([bucket, stat]) => ({
                    bucket,
                    meanAbsError: stat.meanAbsError,
                    meanRealised: stat.meanRealised,
                    meanPredicted: stat.meanPredicted,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="bucket" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
                  <YAxis stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Bar
                    dataKey="meanRealised"
                    fill="#22d3ee"
                    radius={[4, 4, 0, 0]}
                    name="Mean Realised"
                  />
                  <Bar
                    dataKey="meanPredicted"
                    fill="#8b5cf6"
                    radius={[4, 4, 0, 0]}
                    name="Mean Predicted"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold font-mono ${accent ?? 'text-text-primary'}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function MetricBar({ label, value }: { label: string; value: number }) {
  const pct = value * 100;
  return (
    <div>
      <div className="flex justify-between text-xs text-text-muted mb-1">
        <span>{label}</span>
        <span className="font-mono">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-brand-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
