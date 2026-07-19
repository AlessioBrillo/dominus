import { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
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
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { LoginForm } from '@/components/LoginForm';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/candidates', label: 'Candidates', icon: ListChecks },
  { to: '/runs', label: 'Runs', icon: Play },
  { to: '/score', label: 'Score', icon: Search },
  { to: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { to: '/listings', label: 'Listings', icon: ShoppingCart },
  { to: '/bids', label: 'Bids', icon: Gavel },
  { to: '/outcomes', label: 'Outcomes', icon: History },
  { to: '/watchlist', label: 'Watchlist', icon: Eye },
  { to: '/backtest', label: 'Backtest', icon: TrendingUp },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/scheduler', label: 'Scheduler', icon: Clock },
  { to: '/providers', label: 'Providers', icon: Server },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

export function Layout() {
  const { isAuthenticated, isLoading, logout: authLogout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);

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
    return <LoginForm />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg-primary">
      <aside
        className={cn(
          'flex flex-col border-r border-border bg-bg-elevated transition-all duration-200 shrink-0',
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
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-text-muted hover:text-text-primary transition-colors shrink-0"
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-brand-900/40 text-brand-300 font-medium'
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
            onClick={toggleTheme}
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

      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
