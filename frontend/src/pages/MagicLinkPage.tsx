// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { consumeMagicLink } from '@/api/auth';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Landing page of a passwordless sign-in link.
 *
 * The token is redeemed once by the browser; the resulting session is an
 * httpOnly cookie, so no credential is displayed or stored in this page.
 */
export function MagicLinkPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { loginWithSession } = useAuth();
  const token = searchParams.get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setError('The sign-in link is missing its token.');
      setState('failed');
      return;
    }
    let cancelled = false;
    consumeMagicLink(token)
      .then(() => {
        if (cancelled) return;
        loginWithSession();
        setState('done');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'The sign-in link is not valid.');
        setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [token, loginWithSession]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mb-2">
            <h1 className="text-2xl font-bold text-brand-400 tracking-tight">DOMINUS</h1>
            <p className="text-xs text-text-muted">Domain Investment Engine</p>
          </div>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            {state === 'working' && 'Opening your workspace.'}
            {state === 'done' && 'You are signed in'}
            {state === 'failed' && 'The link could not be used'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state === 'done' && (
            <Button type="button" className="w-full" onClick={() => navigate('/')}>
              Open the dashboard
            </Button>
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
        </CardContent>
      </Card>
    </div>
  );
}
