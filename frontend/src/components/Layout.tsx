// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ListChecks,
  BarChart3,
  ShoppingCart,
  Gavel,
  Briefcase,
  History,
  Settings,
  Menu,
  LogOut,
  Sun,
  Moon,
  Play,
  Search,
  Eye,
  TrendingUp,
  Clock,
  Server,
  CreditCard,
  ShieldCheck,
  Gauge,
  Users,
  ShoppingBag,
  Bot,
  Bell,
  X,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useMe } from '@/hooks/useMe';
import { useTheme } from '@/hooks/useTheme';
import { LandingPage } from '@/pages/LandingPage';
import { Button } from '@/components/ui/button';
import { LegalFooter } from '@/components/LegalFooter';
import { cn } from '@/lib/utils';
import { inviteTokenFromPath, rememberInvite, takeInvite } from '@/lib/pending-invite';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/candidates', label: 'Candidates', icon: ListChecks },
  { to: '/runs', label: 'Runs', icon: Play },
  { to: '/score', label: 'Score', icon: Search },
  { to: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { to: '/buy', label: 'Buy', icon: ShoppingBag },
  { to: '/listings', label: 'Listings', icon: ShoppingCart },
  { to: '/bids', label: 'Bids', icon: Gavel },
  { to: '/outcomes', label: 'Outcomes', icon: History },
  { to: '/watchlist', label: 'Watchlist', icon: Eye },
  { to: '/backtest', label: 'Backtest', icon: TrendingUp },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/automation', label: 'Automation', icon: Bot },
  { to: '/sustainability', label: 'Sustainability', icon: Gauge },
  { to: '/credentials', label: 'Credentials', icon: ShieldCheck },
  { to: '/registrar', label: 'Registrar', icon: CreditCard },
  { to: '/providers', label: 'Providers', icon: Server },
  { to: '/billing', label: 'Billing', icon: CreditCard },
  { to: '/team', label: 'Team', icon: Users },
  { to: '/usage', label: 'Usage', icon: Gauge },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

/** Cross-tenant operator panel: only shown to platform operators. */
const operatorNavItems = [
  { to: '/admin', label: 'Admin', icon: ShieldCheck },
  // The scheduler drives the work of every tenant: it is behind the
  // operator role, so the link belongs to the operator group.
  { to: '/scheduler', label: 'Scheduler', icon: Clock },
] as const;

/**
 * The five decision-first destinations of the mobile shell (ADR-0114).
 * Labels are intentionally different from the desktop ones so the two
 * navigations never produce duplicate accessible names in the DOM.
 */
const mobileNavItems = [
  { to: '/', label: 'Today', icon: LayoutDashboard },
  { to: '/score', label: 'Appraise', icon: Search },
  { to: '/portfolio', label: 'Holdings', icon: Briefcase },
  { to: '/alerts', label: 'Alerts', icon: Bell },
] as const;

export function Layout() {
  const { isAuthenticated, isLoading, logout: authLogout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { isOperator } = useMe(isAuthenticated);
  const visibleNav = isOperator ? [...navItems, ...operatorNavItems] : navItems;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => setMoreOpen(false), [pathname]);

  // An invitation link must survive the sign-in screen and the SSO round-trip
  // (the IdP sends the user back to the app root, not to /invite/...).
  useEffect(() => {
    const token = inviteTokenFromPath(pathname);
    if (token) {
      // Only park it while signed out. Once signed in the page itself is the
      // destination; parking it again would bounce the user back here forever.
      if (!isAuthenticated) rememberInvite(token);
      return;
    }
    if (isAuthenticated) {
      const pending = takeInvite();
      if (pending) navigate(`/invite/${pending}`, { replace: true });
    }
  }, [pathname, isAuthenticated, navigate]);

  const handleLogout = (): void => {
    authLogout();
    navigate('/', { replace: true });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-text-muted animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LandingPage />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg-primary">
      <aside
        className={cn(
          'hidden lg:flex flex-col border-r border-border bg-bg-elevated transition-all duration-200 shrink-0',
          sidebarOpen ? 'w-56' : 'w-14',
        )}
      >
        <div
          className={cn(
            'flex items-center border-b border-border',
            sidebarOpen ? 'p-4 justify-between' : 'p-3 justify-center',
          )}
        >
          {sidebarOpen && (
            <div>
              <h1 className="text-base font-bold text-brand-400 tracking-tight">DOMINUS</h1>
              <p className="text-[10px] text-text-muted leading-tight">Domain Investment</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={sidebarOpen}
            className="text-text-muted hover:text-text-primary transition-colors shrink-0"
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>

        <nav aria-label="Main" className="flex-1 p-2 space-y-1">
          {visibleNav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              aria-label={label}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-brand-100 text-brand-800 font-medium dark:bg-brand-900/40 dark:text-brand-300'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {sidebarOpen && label}
            </NavLink>
          ))}
        </nav>

        <div className={cn('border-t border-border space-y-2', sidebarOpen ? 'p-4' : 'p-2')}>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className={cn(
              'flex items-center gap-3 rounded-lg text-sm transition-colors w-full text-text-muted hover:text-text-primary hover:bg-bg-hover',
              sidebarOpen ? 'px-3 py-2' : 'p-2 justify-center',
            )}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {sidebarOpen && (theme === 'dark' ? 'Light Mode' : 'Dark Mode')}
          </button>

          <div
            className={cn('flex items-center gap-2', sidebarOpen ? 'px-3 py-1' : 'justify-center')}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
            {sidebarOpen && <span className="text-[11px] text-text-muted">Connected</span>}
          </div>

          {sidebarOpen && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="w-full justify-start text-text-muted hover:text-red-400"
            >
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-bg-elevated px-4 lg:hidden">
          <h1 className="text-sm font-bold text-brand-400 tracking-tight">DOMINUS</h1>
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="Open all sections"
            className="text-text-muted hover:text-text-primary"
          >
            <Menu className="h-5 w-5" />
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-4 lg:p-6">
          <Outlet />
          <LegalFooter />
        </main>

        <nav
          aria-label="Mobile"
          className="shrink-0 border-t border-border bg-bg-elevated px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:hidden"
        >
          <div className="grid grid-cols-5">
            {mobileNavItems.map(({ to, label, icon: Icon }) => {
              const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
              return (
                <button
                  key={to}
                  type="button"
                  onClick={() => navigate(to)}
                  aria-label={label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-lg text-[10px] transition-colors',
                    active
                      ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-300'
                      : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <span>{label}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label="More"
              className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-lg text-[10px] text-text-muted transition-colors hover:text-text-primary hover:bg-bg-hover"
            >
              <Menu className="h-5 w-5 shrink-0" />
              <span>More</span>
            </button>
          </div>
        </nav>
      </div>

      {moreOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close all sections"
            onClick={() => setMoreOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/60"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="All sections"
            className="absolute bottom-0 left-0 right-0 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-border bg-bg-elevated p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">All sections</h2>
              <button
                type="button"
                aria-label="Close all sections"
                onClick={() => setMoreOpen(false)}
                className="text-text-muted hover:text-text-primary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav aria-label="All sections" className="grid grid-cols-2 gap-2">
              {visibleNav.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors',
                      isActive
                        ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-300'
                        : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
                    )
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </nav>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button variant="ghost" size="sm" onClick={toggleTheme} className="text-text-muted">
                {theme === 'dark' ? (
                  <Sun className="h-4 w-4 mr-2" />
                ) : (
                  <Moon className="h-4 w-4 mr-2" />
                )}
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="text-text-muted hover:text-red-400"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Sign out
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
