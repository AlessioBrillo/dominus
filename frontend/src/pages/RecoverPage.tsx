// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { confirmRecovery, requestRecovery } from '@/api/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The recovery of a lost API key.
 *
 * The key is shown exactly once and only its hash is stored, so a lost key
 * can only be replaced: the owner of the mailbox proves it with the link
 * and receives a new one.
 */
export function RecoverPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sent' | 'working' | 'done' | 'failed'>('idle');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setState('working');
    confirmRecovery(token)
      .then((result) => {
        if (cancelled) return;
        setApiKey(result.key);
        setState('done');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'The recovery link is not valid.');
        setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    setError('');
    try {
      // The answer is the same whether the address exists or not.
      await requestRecovery(email.trim());
      setState('sent');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'The recovery email could not be sent');
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
          <CardTitle>Recover your API key</CardTitle>
          <CardDescription>
            {state === 'working' && 'Checking the link…'}
            {state === 'done' && 'A new key is ready'}
            {state === 'sent' && 'Check your inbox'}
            {state === 'failed' && 'The link could not be used'}
            {state === 'idle' && 'We send a link to the address of the workspace'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state === 'done' && apiKey && (
            <div className="space-y-4">
              <div className="rounded-lg border border-brand-400/40 bg-bg-elevated p-4">
                <p className="text-xs font-medium text-text-muted mb-2">
                  Your new API key (shown once)
                </p>
                <code className="block break-all font-mono text-sm text-brand-300">{apiKey}</code>
              </div>
              <p className="text-xs text-text-muted">
                Save it now. The other keys of the workspace keep working.
              </p>
              <Button type="button" className="w-full" onClick={() => navigate('/')}>
                Go to sign in
              </Button>
            </div>
          )}
          {state === 'failed' && (
            <div className="space-y-4">
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
              <Button type="button" className="w-full" onClick={() => navigate('/')}>
                Back to sign in
              </Button>
            </div>
          )}
          {state === 'sent' && (
            <div className="space-y-4">
              <p className="text-sm text-text-primary">
                If <strong>{email}</strong> belongs to a workspace, a recovery link is on its way.
              </p>
              <Button type="button" className="w-full" onClick={() => navigate('/')}>
                Back to sign in
              </Button>
            </div>
          )}
          {state === 'idle' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                type="email"
                placeholder="Email"
                aria-label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {error && (
                <p role="alert" className="text-xs text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full">
                Send the recovery link
              </Button>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="w-full text-center text-xs text-text-muted hover:text-text-primary"
              >
                Back to sign in
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
