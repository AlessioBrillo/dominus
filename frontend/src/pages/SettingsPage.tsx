import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../hooks/useAuth.js';
import type { ProviderStatus, HealthResponse } from '../types/domain.js';

export function SettingsPage() {
  const { isAuthenticated, logout } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<HealthResponse>('/health'),
      api.get<{ providers: ProviderStatus[] }>('/providers/status'),
    ])
      .then(([h, p]) => {
        setHealth(h);
        setProviders(p.providers);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = (): void => {
    logout();
    window.location.href = '/';
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-bold text-gray-100">Settings</h2>
        <p className="text-sm text-gray-500 mt-1">System configuration and status</p>
      </div>

      <section className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
          Authentication
        </h3>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                isAuthenticated ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-gray-300">
              {isAuthenticated ? 'Authenticated' : 'Not Authenticated'}
            </span>
          </div>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-xs bg-red-900/50 hover:bg-red-800/50 text-red-400 rounded-lg transition-colors border border-red-900"
          >
            Clear API Key
          </button>
        </div>
      </section>

      <section className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
          System Health
        </h3>
        {loading ? (
          <div className="text-gray-500 text-sm animate-pulse">Loading...</div>
        ) : health ? (
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-500 text-xs">Version</div>
              <div className="font-mono text-gray-200">{health.version}</div>
            </div>
            <div>
              <div className="text-gray-500 text-xs">Uptime</div>
              <div className="font-mono text-gray-200">
                {Math.floor(health.uptime / 3600)}h {Math.floor((health.uptime % 3600) / 60)}m
              </div>
            </div>
            <div>
              <div className="text-gray-500 text-xs">Status</div>
              <div className="font-mono text-emerald-400">{health.status}</div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
          Providers
        </h3>
        {loading ? (
          <div className="text-gray-500 text-sm animate-pulse">Loading...</div>
        ) : (
          <div className="space-y-2">
            {providers.map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-950"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${
                      p.configured ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                  <span className="text-sm text-gray-200 font-medium">{p.name}</span>
                </div>
                <span className="text-xs text-gray-500 max-w-96 text-right truncate">{p.note}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
