import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import { LoginForm } from './LoginForm.js';

const navItems = [
  { to: '/', label: 'Dashboard', icon: '◈' },
  { to: '/candidates', label: 'Candidates', icon: '◎' },
  { to: '/analytics', label: 'Analytics', icon: '▤' },
  { to: '/bids', label: 'Bids', icon: '⚡' },
  { to: '/portfolio', label: 'Portfolio', icon: '▣' },
  { to: '/outcomes', label: 'Outcomes', icon: '▤' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
] as const;

export function Layout() {
  const { isAuthenticated, isLoading, logout: authLogout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = (): void => {
    authLogout();
    navigate('/', { replace: true });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-400 animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginForm />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        <div className="p-5 border-b border-gray-800">
          <h1 className="text-lg font-bold text-cyan-400 tracking-tight">DOMINUS</h1>
          <p className="text-xs text-gray-500 mt-0.5">Domain Investment Engine</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-cyan-900/40 text-cyan-300 font-medium'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`
              }
            >
              <span className="w-5 text-center">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-gray-800 space-y-3">
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
            API Connected
          </div>
          <button
            onClick={handleLogout}
            className="w-full px-3 py-1.5 bg-gray-800 hover:bg-red-900/50 text-gray-400 hover:text-red-400 rounded-lg text-xs font-medium transition-colors"
          >
            Logout
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
