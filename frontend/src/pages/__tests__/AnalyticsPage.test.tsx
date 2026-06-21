import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AnalyticsPage, PnlSection, AccuracySection } from '../AnalyticsPage.js';

vi.mock('../../api/analytics.js', () => {
  const pnlReport = {
    generatedAt: '2026-06-18T12:00:00.000Z',
    summary: {
      totalInvestmentEur: 100,
      totalReturnsEur: 300,
      netPnlEur: 200,
      roiPct: 200,
      holdingCostsEur: 0,
      soldCount: 1,
      totalCount: 2,
    },
    perDomain: [
      {
        domain: 'winner.com',
        tld: 'com',
        acquisitionCostEur: 50,
        renewalCostsPaidEur: 0,
        totalCostEur: 50,
        salePriceEur: 300,
        netPnlEur: 250,
        holdingDays: 180,
        verdict: 'keep',
      },
      {
        domain: 'loser.com',
        tld: 'com',
        acquisitionCostEur: 50,
        renewalCostsPaidEur: 0,
        totalCostEur: 50,
        salePriceEur: undefined,
        netPnlEur: -50,
        holdingDays: 90,
        verdict: 'drop',
      },
    ],
    monthlyTrend: [
      { period: '2026-01', investmentEur: 50, returnsEur: 0, netFlowEur: -50 },
      { period: '2026-06', investmentEur: 0, returnsEur: 300, netFlowEur: 300 },
    ],
  };

  const accuracyReport = {
    generatedAt: '2026-06-18T12:00:00.000Z',
    sampleSize: 5,
    overall: { mape: 25, medianApe: 20, mae: 30, rmse: 40, bias: 5, biasPct: 10, sampleSize: 5 },
    confusionMatrix: {
      truePositives: 3,
      falsePositives: 1,
      trueNegatives: 1,
      falseNegatives: 0,
      precision: 0.75,
      recall: 1,
      f1: 0.857,
    },
    calibration: {
      low: { n: 2, meanAbsError: 20, meanRealised: 50, meanPredicted: 40 },
      mid: { n: 2, meanAbsError: 35, meanRealised: 100, meanPredicted: 80 },
      high: { n: 1, meanAbsError: 10, meanRealised: 200, meanPredicted: 190 },
    },
    warnings: [],
  };

  return {
    fetchPnlReport: vi.fn().mockResolvedValue(pnlReport),
    fetchAccuracyReport: vi.fn().mockResolvedValue(accuracyReport),
    refreshAccuracy: vi.fn().mockResolvedValue({ scanned: 5, included: 5 }),
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AnalyticsPage />
    </MemoryRouter>,
  );
}

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page title', () => {
    renderPage();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
  });

  it('renders both tab triggers', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: 'P&L' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Accuracy' })).toBeInTheDocument();
  });
});

describe('PnlSection', () => {
  it('renders P&L metrics after loading', async () => {
    render(<PnlSection />);
    await waitFor(() => {
      expect(screen.getByText('Total Invested')).toBeInTheDocument();
    });
    expect(screen.getByText('€100')).toBeInTheDocument();
    expect(screen.getByText('200.0%')).toBeInTheDocument();
  });

  it('renders per-domain performance', async () => {
    render(<PnlSection />);
    await waitFor(() => {
      expect(screen.getByText('Per-Domain Performance')).toBeInTheDocument();
    });
    expect(screen.getByText('winner.com')).toBeInTheDocument();
    expect(screen.getByText('loser.com')).toBeInTheDocument();
  });

  it('renders monthly trend chart', async () => {
    render(<PnlSection />);
    await waitFor(() => {
      expect(screen.getByText('Monthly P&L Trend')).toBeInTheDocument();
    });
  });
});

describe('AccuracySection', () => {
  it('renders accuracy metrics after loading', async () => {
    render(<AccuracySection />);
    await waitFor(() => {
      expect(screen.getByText('MAPE')).toBeInTheDocument();
    });
    expect(screen.getByText('Sample Size')).toBeInTheDocument();
  });

  it('renders confusion matrix', async () => {
    render(<AccuracySection />);
    await waitFor(() => {
      expect(screen.getByText('Confusion Matrix')).toBeInTheDocument();
    });
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
