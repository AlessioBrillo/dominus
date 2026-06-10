import { useState } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { verifyAndStoreKey } from '../api/auth.js';

export function LoginForm() {
  const { login } = useAuth();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await verifyAndStoreKey(apiKey);
    if (result.success) {
      login(apiKey);
    } else {
      setError(result.error ?? 'Authentication failed');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm">
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-8">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-cyan-400">DOMINUS</h1>
            <p className="text-sm text-gray-500 mt-1">Enter your API key to continue</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-4 py-2.5 bg-gray-950 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-600 focus:outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700 transition-colors text-sm font-mono"
                autoFocus
              />
            </div>

            {error && (
              <div className="text-red-400 text-xs text-center">{error}</div>
            )}

            <button
              type="submit"
              disabled={loading || !apiKey}
              className="w-full py-2.5 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {loading ? 'Verifying...' : 'Authenticate'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
