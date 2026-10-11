// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode, lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ThemeProvider } from '@/hooks/useTheme';
import { AuthProvider } from '@/hooks/useAuth';
import { Layout } from '@/components/Layout';
import { DashboardPage } from '@/pages/DashboardPage';
import '@/styles/globals.css';

// Route-level code splitting. Every page below is a separate chunk, so the
// first paint downloads the shell plus the dashboard instead of all 23
// pages. DashboardPage is the index route and stays eager; everything else
// is fetched on navigation. A page that fails to load (a stale deployment
// mid-roll, a dropped connection on a slow link) surfaces through the
// ErrorBoundary instead of a blank screen.
const OnboardingPage = lazy(() =>
  import('@/pages/OnboardingPage').then((m) => ({ default: m.OnboardingPage })),
);
const CandidatesPage = lazy(() =>
  import('@/pages/CandidatesPage').then((m) => ({ default: m.CandidatesPage })),
);
const RunsPage = lazy(() => import('@/pages/RunsPage').then((m) => ({ default: m.RunsPage })));
const ScorePage = lazy(() => import('@/pages/ScorePage').then((m) => ({ default: m.ScorePage })));
const AnalyticsPage = lazy(() =>
  import('@/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
);
const PortfolioPage = lazy(() =>
  import('@/pages/PortfolioPage').then((m) => ({ default: m.PortfolioPage })),
);
const BuyPage = lazy(() => import('@/pages/BuyPage').then((m) => ({ default: m.BuyPage })));
const ListingsPage = lazy(() =>
  import('@/pages/ListingsPage').then((m) => ({ default: m.ListingsPage })),
);
const BidsPage = lazy(() => import('@/pages/BidsPage').then((m) => ({ default: m.BidsPage })));
const OutcomesPage = lazy(() =>
  import('@/pages/OutcomesPage').then((m) => ({ default: m.OutcomesPage })),
);
const WatchlistPage = lazy(() =>
  import('@/pages/WatchlistPage').then((m) => ({ default: m.WatchlistPage })),
);
const BacktestPage = lazy(() =>
  import('@/pages/BacktestPage').then((m) => ({ default: m.BacktestPage })),
);
const SchedulerPage = lazy(() =>
  import('@/pages/SchedulerPage').then((m) => ({ default: m.SchedulerPage })),
);
const ProvidersPage = lazy(() =>
  import('@/pages/ProvidersPage').then((m) => ({ default: m.ProvidersPage })),
);
const BillingPage = lazy(() =>
  import('@/pages/BillingPage').then((m) => ({ default: m.BillingPage })),
);
const TeamPage = lazy(() => import('@/pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const InvitePage = lazy(() =>
  import('@/pages/InvitePage').then((m) => ({ default: m.InvitePage })),
);
const UsagePage = lazy(() => import('@/pages/UsagePage').then((m) => ({ default: m.UsagePage })));
const AdminPage = lazy(() => import('@/pages/AdminPage').then((m) => ({ default: m.AdminPage })));
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const SignupPage = lazy(() =>
  import('@/pages/SignupPage').then((m) => ({ default: m.SignupPage })),
);
const NotFoundPage = lazy(() =>
  import('@/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);

/** Shown while a route chunk is in flight. */
function RouteFallback() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="p-6 text-sm text-muted">
      Loading…
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AppProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => queryClient);
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProviders>
        <ThemeProvider>
          <TooltipProvider>
            <AuthProvider>
              <ErrorBoundary>
                <Routes>
                  <Route element={<Layout />}>
                    <Route index element={<DashboardPage />} />
                    <Suspense fallback={<RouteFallback />}>
                      <Route path="onboarding" element={<OnboardingPage />} />
                      <Route path="candidates" element={<CandidatesPage />} />
                      <Route path="runs" element={<RunsPage />} />
                      <Route path="score" element={<ScorePage />} />
                      <Route path="analytics" element={<AnalyticsPage />} />
                      <Route path="listings" element={<ListingsPage />} />
                      <Route path="buy" element={<BuyPage />} />
                      <Route path="bids" element={<BidsPage />} />
                      <Route path="portfolio" element={<PortfolioPage />} />
                      <Route path="outcomes" element={<OutcomesPage />} />
                      <Route path="watchlist" element={<WatchlistPage />} />
                      <Route path="backtest" element={<BacktestPage />} />
                      <Route path="scheduler" element={<SchedulerPage />} />
                      <Route path="providers" element={<ProvidersPage />} />
                      <Route path="billing" element={<BillingPage />} />
                      <Route path="team" element={<TeamPage />} />
                      <Route path="invite/:token" element={<InvitePage />} />
                      <Route path="usage" element={<UsagePage />} />
                      <Route path="admin" element={<AdminPage />} />
                      <Route path="settings" element={<SettingsPage />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Suspense>
                  </Route>
                  <Suspense fallback={<RouteFallback />}>
                    <Route path="signup" element={<SignupPage />} />
                  </Suspense>
                </Routes>
              </ErrorBoundary>
              <Toaster
                position="bottom-right"
                theme="dark"
                toastOptions={{
                  style: {
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                  },
                }}
              />
            </AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
);
