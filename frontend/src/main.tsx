import { StrictMode, useState } from 'react';
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
import { OnboardingPage } from '@/pages/OnboardingPage';
import { CandidatesPage } from '@/pages/CandidatesPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { PortfolioPage } from '@/pages/PortfolioPage';
import { BidsPage } from '@/pages/BidsPage';
import { OutcomesPage } from '@/pages/OutcomesPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import '@/styles/globals.css';

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
                    <Route path="onboarding" element={<OnboardingPage />} />
                    <Route path="candidates" element={<CandidatesPage />} />
                    <Route path="analytics" element={<AnalyticsPage />} />
                    <Route path="bids" element={<BidsPage />} />
                    <Route path="portfolio" element={<PortfolioPage />} />
                    <Route path="outcomes" element={<OutcomesPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                    <Route path="*" element={<NotFoundPage />} />
                  </Route>
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
