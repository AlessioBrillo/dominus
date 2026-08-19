// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getSsoStatus, startSsoLogin } from '@/api/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function LoginForm() {
  const { login } = useAuth();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoAvailable, setSsoAvailable] = useState(false);
  const [ssoChecking, setSsoChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getSsoStatus()
      .then(({ available }) => {
        if (!cancelled) setSsoAvailable(available);
      })
      .finally(() => {
        if (!cancelled) setSsoChecking(false);
      });
    const params = new URLSearchParams(window.location.search);
    if (params.get('sso_error')) {
      setError('Single sign-on failed. Try again or use your API key.');
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) {
      setError('API key is required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await login(key.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mb-2">
            <h1 className="text-2xl font-bold text-brand-400 tracking-tight">DOMINUS</h1>
            <p className="text-xs text-text-muted">Domain Investment Engine</p>
          </div>
          <CardTitle>Sign In</CardTitle>
          <CardDescription>Enter your API key to access the dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="password"
              placeholder="API Key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <Button type="submit" disabled={loading} className="w-full">
              {loading ? 'Authenticating...' : 'Authenticate'}
            </Button>
            {!ssoChecking && ssoAvailable && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => startSsoLogin()}
              >
                Sign in with SSO
              </Button>
            )}
            <a
              href="/signup"
              className="block w-full text-center text-xs text-text-muted hover:text-text-primary"
            >
              New here? Create a workspace
            </a>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
