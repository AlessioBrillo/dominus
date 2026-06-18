import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth.js';
import { Layout } from './components/Layout.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { CandidatesPage } from './pages/CandidatesPage.js';
import { AnalyticsPage } from './pages/AnalyticsPage.js';
import { PortfolioPage } from './pages/PortfolioPage.js';
import { BidsPage } from './pages/BidsPage.js';
import { OutcomesPage } from './pages/OutcomesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="candidates" element={<CandidatesPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="bids" element={<BidsPage />} />
            <Route path="portfolio" element={<PortfolioPage />} />
            <Route path="outcomes" element={<OutcomesPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
