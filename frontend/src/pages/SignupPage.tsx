// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerTenant } from '@/api/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function SignupPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await registerTenant({
        name: name.trim(),
        email: email.trim() ? email.trim() : undefined,
      });
      setApiKey(result.key);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed');
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
          <CardTitle>Create your workspace</CardTitle>
          <CardDescription>Start with the free tier — upgrade anytime</CardDescription>
        </CardHeader>
        <CardContent>
          {apiKey ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-brand-400/40 bg-bg-elevated p-4">
                <p className="text-xs font-medium text-text-muted mb-2">
                  Your API key (shown once)
                </p>
                <code className="block break-all font-mono text-sm text-brand-300">{apiKey}</code>
              </div>
              <p className="text-xs text-text-muted">Save it now. It will not be shown again.</p>
              <Button type="button" className="w-full" onClick={() => navigate('/')}>
                Go to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                type="text"
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <Input
                type="email"
                placeholder="Email (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {error && <p className="text-xs text-danger">{error}</p>}
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? 'Creating...' : 'Create workspace'}
              </Button>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="w-full text-center text-xs text-text-muted hover:text-text-primary"
              >
                Already have an account? Sign in
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
