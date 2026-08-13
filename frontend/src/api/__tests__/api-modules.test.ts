// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  storeApiKey: vi.fn(),
}));

import { api, storeApiKey } from '@/api/client';
import { fetchPnlReport, refreshAccuracy, fetchAccuracyReport } from '../analytics.js';
import { verifyAndStoreKey, checkHealth } from '../auth.js';
import { rebuildSnapshot, fetchBacktestReport, suggestWeights, runAutoTune } from '../backtest.js';
import { placeBid, resolveBid, listBids, listPendingBids, getBid } from '../bids.js';
import { fetchSubscription, createCheckoutSession, createPortalSession } from '../billing.js';
import { fetchAdminOverview, fetchAdminTenants } from '../admin.js';
import { fetchCandidates, runPipeline, deleteCandidate, fetchRuns } from '../candidates.js';
import { fetchDashboardStats } from '../dashboard.js';
import {
  listListings,
  getListing,
  createListing,
  updateListing,
  deleteListing,
  publishListing,
  syncListings,
  listOffers,
  recordOffer,
  acceptOffer,
  declineOffer,
} from '../listings.js';
import {
  runSample,
  importPortfolio,
  getOnboardingState,
  updateOnboardingState,
} from '../onboarding.js';
import { createOutcome, listOutcomes } from '../outcomes.js';
import {
  fetchPortfolio,
  rescorePortfolio,
  refreshVerdicts,
  updateVerdict,
  removeFromPortfolio,
  updatePortfolioEntry,
} from '../portfolio.js';
import { fetchProviderStatuses } from '../providers.js';
import { shareScore, getPublicScore } from '../public.js';
import { preflightPurchase, executePurchase, checkPrices } from '../purchase.js';
import {
  fetchRuns as fetchPipelineRuns,
  fetchRun,
  submitRun,
  deleteRun,
  pruneRuns,
} from '../runs.js';
import { fetchSchedulerStatus, runSchedulerJob } from '../scheduler.js';
import { scoreDomain } from '../score.js';
import {
  fetchWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  pollWatchlist,
} from '../watchlist.js';

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);
const mockedPatch = vi.mocked(api.patch);
const mockedDelete = vi.mocked(api.delete);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('api/analytics', () => {
  it('fetchPnlReport gets the PnL report', async () => {
    const report = { pnl: [] };
    mockedGet.mockResolvedValueOnce(report);
    await expect(fetchPnlReport()).resolves.toBe(report);
    expect(mockedGet).toHaveBeenCalledWith('/analytics/pnl');
  });

  it('refreshAccuracy posts a refresh', async () => {
    mockedPost.mockResolvedValueOnce({ scanned: 3, included: 2 });
    await expect(refreshAccuracy()).resolves.toEqual({ scanned: 3, included: 2 });
    expect(mockedPost).toHaveBeenCalledWith('/analytics/refresh');
  });

  it('fetchAccuracyReport gets the accuracy report', async () => {
    mockedGet.mockResolvedValueOnce({ accuracy: 0.9 });
    await expect(fetchAccuracyReport()).resolves.toEqual({ accuracy: 0.9 });
    expect(mockedGet).toHaveBeenCalledWith('/analytics/accuracy');
  });
});

describe('api/auth', () => {
  it('verifyAndStoreKey stores the token on success', async () => {
    mockedPost.mockResolvedValueOnce({ authenticated: true, token: 'tok' });
    await expect(verifyAndStoreKey('key')).resolves.toEqual({ success: true });
    expect(mockedPost).toHaveBeenCalledWith('/auth/login', { apiKey: 'key' });
    expect(storeApiKey).toHaveBeenCalledWith('tok');
  });

  it('verifyAndStoreKey reports the server error when not authenticated', async () => {
    mockedPost.mockResolvedValueOnce({ authenticated: false, error: 'Invalid key' });
    await expect(verifyAndStoreKey('key')).resolves.toEqual({
      success: false,
      error: 'Invalid key',
    });
    expect(storeApiKey).not.toHaveBeenCalled();
  });

  it('verifyAndStoreKey falls back to a generic message', async () => {
    mockedPost.mockResolvedValueOnce({ authenticated: false });
    await expect(verifyAndStoreKey('key')).resolves.toEqual({
      success: false,
      error: 'Authentication failed',
    });
  });

  it('verifyAndStoreKey catches thrown errors', async () => {
    mockedPost.mockRejectedValueOnce(new Error('network down'));
    await expect(verifyAndStoreKey('key')).resolves.toEqual({
      success: false,
      error: 'network down',
    });
  });

  it('checkHealth resolves true on success and false on failure', async () => {
    mockedGet.mockResolvedValueOnce({ status: 'ok' });
    await expect(checkHealth()).resolves.toBe(true);
    mockedGet.mockRejectedValueOnce(new Error('down'));
    await expect(checkHealth()).resolves.toBe(false);
  });
});

describe('api/backtest', () => {
  it('rebuildSnapshot posts the snapshot rebuild', async () => {
    mockedPost.mockResolvedValueOnce({ rebuilt: true, outcomeCount: 1, signalCount: 2 });
    await expect(rebuildSnapshot()).resolves.toMatchObject({ rebuilt: true });
    expect(mockedPost).toHaveBeenCalledWith('/backtest/snapshot');
  });

  it('fetchBacktestReport posts the report request', async () => {
    mockedPost.mockResolvedValueOnce({ sampleSize: 10, accuracy: {} });
    await expect(fetchBacktestReport()).resolves.toMatchObject({ sampleSize: 10 });
    expect(mockedPost).toHaveBeenCalledWith('/backtest/report');
  });

  it('suggestWeights posts the apply flag', async () => {
    mockedPost.mockResolvedValueOnce({ suggested: {}, current: {}, delta: {}, sampleSize: 1 });
    await suggestWeights(true);
    expect(mockedPost).toHaveBeenCalledWith('/backtest/suggest-weights', { apply: true });
  });

  it('runAutoTune posts the auto-tune request', async () => {
    mockedPost.mockResolvedValueOnce({ applied: true, dryRun: true, suggestion: {} });
    await expect(runAutoTune()).resolves.toMatchObject({ applied: true });
    expect(mockedPost).toHaveBeenCalledWith('/backtest/auto-tune');
  });
});

describe('api/bids', () => {
  it('placeBid posts the bid', async () => {
    mockedPost.mockResolvedValueOnce({ bid: { domain: 'a.com' } });
    await placeBid({ domain: 'a.com', bidAmountEur: 100 });
    expect(mockedPost).toHaveBeenCalledWith('/bids/place', {
      domain: 'a.com',
      bidAmountEur: 100,
    });
  });

  it('resolveBid posts the resolution', async () => {
    mockedPost.mockResolvedValueOnce({ bid: { domain: 'a.com' } });
    await resolveBid({ domain: 'a.com', status: 'won' });
    expect(mockedPost).toHaveBeenCalledWith('/bids/resolve', { domain: 'a.com', status: 'won' });
  });

  it('listBids appends the status filter', async () => {
    mockedGet.mockResolvedValueOnce({ bids: [] });
    await listBids('pending');
    expect(mockedGet).toHaveBeenCalledWith('/bids?status=pending');
    await listBids();
    expect(mockedGet).toHaveBeenLastCalledWith('/bids');
  });

  it('listPendingBids gets the pending list', async () => {
    mockedGet.mockResolvedValueOnce({ bids: [] });
    await listPendingBids();
    expect(mockedGet).toHaveBeenCalledWith('/bids/pending');
  });

  it('getBid encodes the domain', async () => {
    mockedGet.mockResolvedValueOnce({ bid: {} });
    await getBid('ex ample.com');
    expect(mockedGet).toHaveBeenCalledWith('/bids/ex%20ample.com');
  });
});

describe('api/billing', () => {
  it('fetchSubscription gets the billing data', async () => {
    mockedGet.mockResolvedValueOnce({ subscription: {}, plans: [] });
    await expect(fetchSubscription()).resolves.toMatchObject({ plans: [] });
    expect(mockedGet).toHaveBeenCalledWith('/billing');
  });

  it('createCheckoutSession posts plan and interval', async () => {
    mockedPost.mockResolvedValueOnce({ url: 'https://checkout', plan: 'pro' });
    await createCheckoutSession('pro', 'year', 'https://ok', 'https://cancel');
    expect(mockedPost).toHaveBeenCalledWith('/billing/checkout', {
      plan: 'pro',
      interval: 'year',
      successUrl: 'https://ok',
      cancelUrl: 'https://cancel',
    });
  });

  it('createPortalSession posts the return URL', async () => {
    mockedPost.mockResolvedValueOnce({ url: 'https://portal' });
    await createPortalSession('https://back');
    expect(mockedPost).toHaveBeenCalledWith('/billing/portal', { returnUrl: 'https://back' });
  });
});

describe('api/admin', () => {
  it('fetchAdminOverview gets the platform overview', async () => {
    mockedGet.mockResolvedValueOnce({ tenantsCount: 2 });
    await expect(fetchAdminOverview()).resolves.toMatchObject({ tenantsCount: 2 });
    expect(mockedGet).toHaveBeenCalledWith('/admin/overview');
  });

  it('fetchAdminTenants gets the tenants list', async () => {
    mockedGet.mockResolvedValueOnce([{ tenantId: 'tenant-a' }]);
    await expect(fetchAdminTenants()).resolves.toEqual([{ tenantId: 'tenant-a' }]);
    expect(mockedGet).toHaveBeenCalledWith('/admin/tenants');
  });
});

describe('api/candidates', () => {
  it('fetchCandidates appends the runId filter and unwraps candidates', async () => {
    mockedGet.mockResolvedValueOnce({ candidates: [1] });
    await expect(fetchCandidates('r1')).resolves.toEqual([1]);
    expect(mockedGet).toHaveBeenCalledWith('/candidates?runId=r1');
    mockedGet.mockResolvedValueOnce({ candidates: [] });
    await fetchCandidates();
    expect(mockedGet).toHaveBeenLastCalledWith('/candidates');
  });

  it('runPipeline posts the run request', async () => {
    mockedPost.mockResolvedValueOnce({ runId: 'r1', recommended: [], stageSummary: {} });
    await runPipeline({ keywords: ['a'] });
    expect(mockedPost).toHaveBeenCalledWith('/candidates/run', { keywords: ['a'] });
  });

  it('deleteCandidate deletes by domain', async () => {
    mockedDelete.mockResolvedValueOnce(undefined);
    await deleteCandidate('a.com');
    expect(mockedDelete).toHaveBeenCalledWith('/candidates/a.com');
  });

  it('fetchRuns unwraps the runs list', async () => {
    mockedGet.mockResolvedValueOnce({ runs: [1] });
    await expect(fetchRuns()).resolves.toEqual([1]);
    expect(mockedGet).toHaveBeenCalledWith('/runs');
  });
});

describe('api/dashboard', () => {
  it('aggregates stats from health, portfolio and alerts', async () => {
    mockedGet
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce({
        portfolio: [
          { entry: { verdict: 'keep', suggestedListPrice: 100 }, renewalClock: {} },
          { entry: { verdict: 'drop' }, renewalClock: {} },
          { entry: { verdict: 'reprice', suggestedListPrice: 50 }, renewalClock: {} },
        ],
      })
      .mockResolvedValueOnce({
        alerts: [
          { acknowledgedAt: null },
          { acknowledgedAt: '2026-01-01' },
          { acknowledgedAt: null },
          { acknowledgedAt: null },
        ],
      });

    const result = await fetchDashboardStats();

    expect(result.partialFailure).toBe(false);
    expect(result.stats.totalDomains).toBe(3);
    expect(result.stats.keepCount).toBe(1);
    expect(result.stats.dropCount).toBe(1);
    expect(result.stats.repriceCount).toBe(1);
    expect(result.stats.totalListValue).toBe(150);
    expect(result.stats.activeAlertCount).toBe(3);
    expect(result.stats.recentAlerts).toHaveLength(3);
    expect(result.stats.health).toEqual({ status: 'ok' });
  });

  it('aggregates partial failures without throwing', async () => {
    mockedGet
      .mockRejectedValueOnce(new Error('health down'))
      .mockResolvedValueOnce({ portfolio: [] })
      .mockRejectedValueOnce(new Error('alerts down'));

    const result = await fetchDashboardStats();

    expect(result.partialFailure).toBe(true);
    expect(result.failureReasons).toEqual(['health', 'alerts']);
    expect(result.stats.health).toBeNull();
    expect(result.stats.activeAlertCount).toBe(0);
  });
});

describe('api/listings', () => {
  it('listListings builds query params only from provided filters', async () => {
    mockedGet.mockResolvedValueOnce({ listings: [] });
    await listListings('active', 'afternic', 'a.com');
    expect(mockedGet).toHaveBeenCalledWith(
      '/listings?status=active&marketplace=afternic&domain=a.com',
    );
    await listListings();
    expect(mockedGet).toHaveBeenLastCalledWith('/listings');
  });

  it('getListing fetches listing and offers by id', async () => {
    mockedGet.mockResolvedValueOnce({ listing: {}, offers: [] });
    await getListing(7);
    expect(mockedGet).toHaveBeenCalledWith('/listings/7');
  });

  it('createListing posts the input', async () => {
    mockedPost.mockResolvedValueOnce({ listing: {} });
    await createListing({ domain: 'a.com', price: 100 });
    expect(mockedPost).toHaveBeenCalledWith('/listings', { domain: 'a.com', price: 100 });
  });

  it('updateListing patches by id', async () => {
    mockedPatch.mockResolvedValueOnce({ listing: {} });
    await updateListing(7, { priceEur: 150 });
    expect(mockedPatch).toHaveBeenCalledWith('/listings/7', { priceEur: 150 });
  });

  it('deleteListing deletes by id', async () => {
    mockedDelete.mockResolvedValueOnce(undefined);
    await deleteListing(7);
    expect(mockedDelete).toHaveBeenCalledWith('/listings/7');
  });

  it('publishListing posts the publish action', async () => {
    mockedPost.mockResolvedValueOnce({ listing: {} });
    await publishListing(7);
    expect(mockedPost).toHaveBeenCalledWith('/listings/7/publish');
  });

  it('syncListings posts the sync action', async () => {
    mockedPost.mockResolvedValueOnce({ listings: [], offers: [], errors: [] });
    await syncListings();
    expect(mockedPost).toHaveBeenCalledWith('/listings/sync');
  });

  it('listOffers gets offers for a listing', async () => {
    mockedGet.mockResolvedValueOnce({ offers: [] });
    await listOffers(7);
    expect(mockedGet).toHaveBeenCalledWith('/listings/7/offers');
  });

  it('recordOffer posts an offer', async () => {
    mockedPost.mockResolvedValueOnce({ offer: {} });
    await recordOffer(7, { amount: 50, buyer: 'b' });
    expect(mockedPost).toHaveBeenCalledWith('/listings/7/offers', {
      amount: 50,
      buyer: 'b',
    });
  });

  it('acceptOffer and declineOffer post the decisions', async () => {
    mockedPost.mockResolvedValueOnce({ status: 'accepted' });
    await acceptOffer(7, 3);
    expect(mockedPost).toHaveBeenCalledWith('/listings/7/offers/3/accept');
    mockedPost.mockResolvedValueOnce({ status: 'declined' });
    await declineOffer(7, 3);
    expect(mockedPost).toHaveBeenCalledWith('/listings/7/offers/3/decline');
  });
});

describe('api/onboarding', () => {
  it('runSample posts the sample run', async () => {
    mockedPost.mockResolvedValueOnce({ results: [], sampleCount: 0 });
    await runSample();
    expect(mockedPost).toHaveBeenCalledWith('/onboarding/sample-run');
  });

  it('importPortfolio posts the domains', async () => {
    mockedPost.mockResolvedValueOnce({ imported: 1, verdicts: [], summary: {} });
    await importPortfolio([]);
    expect(mockedPost).toHaveBeenCalledWith('/onboarding/portfolio/import', { domains: [] });
  });

  it('getOnboardingState gets the state', async () => {
    mockedGet.mockResolvedValueOnce({ currentStep: 's1', stepData: null, completedAt: null });
    await getOnboardingState();
    expect(mockedGet).toHaveBeenCalledWith('/onboarding/state');
  });

  it('updateOnboardingState patches the step', async () => {
    mockedPatch.mockResolvedValueOnce({ currentStep: 's2', saved: true });
    await updateOnboardingState('s2', { x: 1 });
    expect(mockedPatch).toHaveBeenCalledWith('/onboarding/state', {
      currentStep: 's2',
      stepData: { x: 1 },
    });
  });
});

describe('api/outcomes', () => {
  it('createOutcome unwraps the outcome', async () => {
    mockedPost.mockResolvedValueOnce({ outcome: { domain: 'a.com' } });
    await expect(
      createOutcome({ domain: 'a.com', type: 'sold', occurredAt: '2026-01-01' }),
    ).resolves.toEqual({
      domain: 'a.com',
    });
    expect(mockedPost).toHaveBeenCalledWith('/outcomes', {
      domain: 'a.com',
      type: 'sold',
      occurredAt: '2026-01-01',
    });
  });

  it('listOutcomes appends the type filter and unwraps', async () => {
    mockedGet.mockResolvedValueOnce({ outcomes: [1] });
    await expect(listOutcomes('sold')).resolves.toEqual([1]);
    expect(mockedGet).toHaveBeenCalledWith('/outcomes?type=sold');
    mockedGet.mockResolvedValueOnce({ outcomes: [] });
    await listOutcomes();
    expect(mockedGet).toHaveBeenLastCalledWith('/outcomes');
  });
});

describe('api/portfolio', () => {
  it('fetchPortfolio unwraps the renewal-clock envelope', async () => {
    mockedGet.mockResolvedValueOnce({
      portfolio: [
        { entry: { domain: 'a.com', verdict: 'keep' }, renewalClock: { domain: 'a.com' } },
      ],
    });
    await expect(fetchPortfolio()).resolves.toEqual({
      portfolio: [{ domain: 'a.com', verdict: 'keep' }],
    });
    expect(mockedGet).toHaveBeenCalledWith('/portfolio', undefined);
  });

  it('fetchPortfolio handles an empty portfolio', async () => {
    mockedGet.mockResolvedValueOnce({ portfolio: [] });
    await expect(fetchPortfolio()).resolves.toEqual({ portfolio: [] });
    expect(mockedGet).toHaveBeenCalledWith('/portfolio', undefined);
  });

  it('rescorePortfolio posts the rescore', async () => {
    mockedPost.mockResolvedValueOnce({ totalDurationMs: 1, results: [] });
    await rescorePortfolio();
    expect(mockedPost).toHaveBeenCalledWith('/portfolio/rescore');
  });

  it('refreshVerdicts posts the verdict refresh', async () => {
    mockedPost.mockResolvedValueOnce({ ok: true });
    await refreshVerdicts();
    expect(mockedPost).toHaveBeenCalledWith('/portfolio/verdicts');
  });

  it('updateVerdict patches by domain', async () => {
    mockedPatch.mockResolvedValueOnce({ ok: true });
    await updateVerdict('a.com', { verdict: 'keep' });
    expect(mockedPatch).toHaveBeenCalledWith('/portfolio/a.com/verdict', { verdict: 'keep' });
  });

  it('removeFromPortfolio deletes by domain', async () => {
    mockedDelete.mockResolvedValueOnce(undefined);
    await removeFromPortfolio('a.com');
    expect(mockedDelete).toHaveBeenCalledWith('/portfolio/a.com');
  });

  it('updatePortfolioEntry patches notes and costs', async () => {
    mockedPatch.mockResolvedValueOnce({ ok: true });
    await updatePortfolioEntry('a.com', { notes: 'n' });
    expect(mockedPatch).toHaveBeenCalledWith('/portfolio/a.com', { notes: 'n' });
  });
});

describe('api/providers', () => {
  it('fetchProviderStatuses unwraps the providers', async () => {
    mockedGet.mockResolvedValueOnce({ providers: [1] });
    await expect(fetchProviderStatuses()).resolves.toEqual([1]);
    expect(mockedGet).toHaveBeenCalledWith('/providers/status');
  });
});

describe('api/public', () => {
  it('shareScore posts the domain', async () => {
    mockedPost.mockResolvedValueOnce({ slug: 's', url: 'u', domain: 'a.com' });
    await shareScore('a.com');
    expect(mockedPost).toHaveBeenCalledWith('/public/scores', { domain: 'a.com' });
  });

  it('getPublicScore gets by slug', async () => {
    mockedGet.mockResolvedValueOnce({ slug: 's' });
    await getPublicScore('s');
    expect(mockedGet).toHaveBeenCalledWith('/public/s/s');
  });
});

describe('api/purchase', () => {
  it('preflightPurchase encodes the domain', async () => {
    mockedGet.mockResolvedValueOnce({ check: {} });
    await preflightPurchase('a.com');
    expect(mockedGet).toHaveBeenCalledWith('/purchase/preflight?domain=a.com');
  });

  it('executePurchase posts years and operatorApproved with defaults', async () => {
    mockedPost.mockResolvedValueOnce({ success: true });
    await executePurchase('a.com');
    expect(mockedPost).toHaveBeenCalledWith('/purchase/execute', {
      domain: 'a.com',
      years: 1,
      operatorApproved: false,
    });
    await executePurchase('a.com', 3, true);
    expect(mockedPost).toHaveBeenLastCalledWith('/purchase/execute', {
      domain: 'a.com',
      years: 3,
      operatorApproved: true,
    });
  });

  it('checkPrices joins the domains', async () => {
    mockedGet.mockResolvedValueOnce({ prices: [] });
    await checkPrices(['a.com', 'b.com']);
    expect(mockedGet).toHaveBeenCalledWith('/purchase/price?domains=a.com,b.com');
  });
});

describe('api/runs', () => {
  it('fetchRuns builds since and limit params', async () => {
    mockedGet.mockResolvedValueOnce({ runs: [1] });
    await fetchPipelineRuns('2026-01-01', 25);
    expect(mockedGet).toHaveBeenCalledWith('/runs?since=2026-01-01&limit=25');
    mockedGet.mockResolvedValueOnce({ runs: [] });
    await fetchPipelineRuns();
    expect(mockedGet).toHaveBeenLastCalledWith('/runs');
  });

  it('fetchRun gets by id', async () => {
    mockedGet.mockResolvedValueOnce({ id: 'r1' });
    await fetchRun('r1');
    expect(mockedGet).toHaveBeenCalledWith('/runs/r1');
  });

  it('submitRun posts the input', async () => {
    mockedPost.mockResolvedValueOnce({ runId: 'r1' });
    await submitRun({ keywords: ['a'] });
    expect(mockedPost).toHaveBeenCalledWith('/runs', { keywords: ['a'] });
  });

  it('deleteRun deletes by id', async () => {
    mockedDelete.mockResolvedValueOnce(undefined);
    await deleteRun('r1');
    expect(mockedDelete).toHaveBeenCalledWith('/runs/r1');
  });

  it('pruneRuns posts the dryRun flag', async () => {
    mockedPost.mockResolvedValueOnce({ deleted: 3 });
    await expect(pruneRuns(true)).resolves.toEqual({ deleted: 3 });
    expect(mockedPost).toHaveBeenCalledWith('/runs/prune', { dryRun: true });
  });
});

describe('api/scheduler', () => {
  it('fetchSchedulerStatus unwraps the jobs', async () => {
    mockedGet.mockResolvedValueOnce({ jobs: [1] });
    await expect(fetchSchedulerStatus()).resolves.toEqual([1]);
    expect(mockedGet).toHaveBeenCalledWith('/scheduler');
  });

  it('runSchedulerJob posts by job name', async () => {
    mockedPost.mockResolvedValueOnce({ started: true });
    await runSchedulerJob('backup');
    expect(mockedPost).toHaveBeenCalledWith('/scheduler/run/backup');
  });
});

describe('api/score', () => {
  it('scoreDomain builds query params only from present flags', async () => {
    mockedGet.mockResolvedValueOnce({ domain: 'a.com', score: {} });
    await scoreDomain('a.com', { closeout: true, age: 5, backlinks: 2, wayback: 1 });
    expect(mockedGet).toHaveBeenCalledWith(
      '/score/a.com?closeout=true&age=5&backlinks=2&wayback=1',
    );
    mockedGet.mockResolvedValueOnce({ domain: 'a.com', score: {} });
    await scoreDomain('a.com');
    expect(mockedGet).toHaveBeenLastCalledWith('/score/a.com');
    mockedGet.mockResolvedValueOnce({ domain: 'a.com', score: {} });
    await scoreDomain('a.com', { age: 0 });
    expect(mockedGet).toHaveBeenLastCalledWith('/score/a.com?age=0');
  });
});

describe('api/watchlist', () => {
  it('fetchWatchlist unwraps entries', async () => {
    mockedGet.mockResolvedValueOnce({ entries: [1] });
    await expect(fetchWatchlist()).resolves.toEqual([1]);
    expect(mockedGet).toHaveBeenCalledWith('/watchlist');
  });

  it('addToWatchlist posts domain and notes', async () => {
    mockedPost.mockResolvedValueOnce({ domain: 'a.com' });
    await addToWatchlist('a.com', 'note');
    expect(mockedPost).toHaveBeenCalledWith('/watchlist', { domain: 'a.com', notes: 'note' });
    mockedPost.mockResolvedValueOnce({ domain: 'a.com' });
    await addToWatchlist('a.com');
    expect(mockedPost).toHaveBeenLastCalledWith('/watchlist', {
      domain: 'a.com',
      notes: undefined,
    });
  });

  it('removeFromWatchlist deletes by domain', async () => {
    mockedDelete.mockResolvedValueOnce(undefined);
    await removeFromWatchlist('a.com');
    expect(mockedDelete).toHaveBeenCalledWith('/watchlist/a.com');
  });

  it('pollWatchlist posts the poll', async () => {
    mockedPost.mockResolvedValueOnce({ checked: 1, changed: 1 });
    await pollWatchlist();
    expect(mockedPost).toHaveBeenCalledWith('/watchlist/poll');
  });
});
