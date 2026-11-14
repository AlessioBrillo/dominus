// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { verifyEmail } from '@/api/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The landing page of the signup verification link.
 *
 * The link proves that the mailbox belongs to the person who opened it.
 * Until it is opened the workspace is inert: no API key, no seat that can
 * be claimed through single sign-on.
 */
export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setState('failed');
      setError('The verification link is missing its token.');
      return;
    }
    let cancelled = false;
    setState('working');
    verifyEmail(token)
      .then((result) => {
        if (cancelled) return;
        setApiKey(result.key);
        setState('done');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'The verification link is not valid.');
        setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mb-2">
            <h1 className="text-2xl font-bold text-brand-400 tracking-tight">DOMINUS</h1>
            <p className="text-xs text-text-muted">Domain Investment Engine</p>
          </div>
          <CardTitle>Email verification</CardTitle>
          <CardDescription>
            {state === 'working' && 'Verifying…'}
            {state === 'done' && 'Your workspace is ready'}
            {state === 'failed' && 'The link could not be used'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state === 'done' && apiKey && (
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
          )}
          {state === 'failed' && (
            <div className="space-y-4">
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
              <Button type="button" className="w-full" onClick={() => navigate('/signup')}>
                Back to signup
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
