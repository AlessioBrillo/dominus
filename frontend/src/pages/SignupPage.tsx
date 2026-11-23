// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { registerTenant } from '@/api/auth';
import { recordAcceptance } from '@/api/contracts';
import { useLegalContent } from '@/hooks/useLegalContent';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const REPOSITORY_URL = 'https://github.com/AlessioBrillo/dominus';

export function SignupPage() {
  const navigate = useNavigate();
  const { data: legal, isLoading, isError } = useLegalContent();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [isAdult, setIsAdult] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);

  const isWaitlist = legal?.status === 'cloud_waitlist';
  const waitlistHref = legal?.waitlistUrl ?? REPOSITORY_URL;

  // A closed signup must not flicker into a workspace form while the legal
  // status is in flight, or when the endpoint cannot be reached. The backend
  // closes /register anyway; the UI must not invite the attempt.
  if (isLoading || isError || !legal) {
    return (
      <div
        role="status"
        className="flex min-h-screen items-center justify-center bg-bg-primary p-4 text-sm text-text-muted"
      >
        {isError
          ? 'The service status could not be checked. Please try again.'
          : 'Checking service status…'}
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    // The address identifies the owner of the workspace: it is how the
    // workspace is verified, recovered and claimed through single sign-on.
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    if (!acceptedTerms) {
      setError('Accept the Terms of Service and the Privacy Notice to continue');
      return;
    }
    if (!isAdult) {
      setError('You must confirm that you are at least 18 years old');
      return;
    }
    setLoading(true);
    setError('');
    try {
      // Record the acceptance before creating the workspace: the backend
      // refuses a registration it cannot tie to a specific version of the
      // terms and privacy notice.
      if (legal.version && legal.contentHash) {
        await recordAcceptance({
          email: email.trim(),
          purpose: 'signup',
          documentSlug: 'terms',
          documentVersion: legal.version,
          contentHash: legal.contentHash,
        });
        await recordAcceptance({
          email: email.trim(),
          purpose: 'signup',
          documentSlug: 'privacy',
          documentVersion: legal.version,
          contentHash: legal.contentHash,
        });
      }
      const result = await registerTenant({
        name: name.trim(),
        email: email.trim(),
        ...(legal.version && legal.contentHash
          ? {
              contractAcceptance: {
                documentVersion: legal.version,
                contentHash: legal.contentHash,
              },
            }
          : {}),
      });
      if (result.key) {
        setApiKey(result.key);
      } else {
        setVerificationSent(true);
      }
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
          <CardTitle>
            {isWaitlist ? 'The hosted edition is not open yet' : 'Create your workspace'}
          </CardTitle>
          <CardDescription>
            {isWaitlist
              ? 'Join the waitlist and we will tell you when DOMINUS Cloud opens.'
              : 'Start with the free tier - upgrade anytime'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isWaitlist ? (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary">
                DOMINUS Cloud is not on sale yet. No workspace is created and no payment is
                collected while this page says so. The community edition is available now and runs
                on your own infrastructure.
              </p>
              <a
                href={waitlistHref}
                rel="noreferrer"
                className="block w-full rounded-lg bg-brand-700 px-3 py-2 text-center text-sm font-medium text-white hover:opacity-90"
              >
                {legal?.waitlistUrl ? 'Join the waitlist' : 'Follow the project'}
              </a>
              <a
                href={REPOSITORY_URL}
                rel="noreferrer"
                className="block w-full rounded-lg border border-border px-3 py-2 text-center text-sm font-medium text-text-primary hover:bg-bg-hover"
              >
                Install the community edition
              </a>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="w-full text-center text-xs text-text-muted hover:text-text-primary"
              >
                Back to the home page
              </button>
            </div>
          ) : apiKey ? (
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
          ) : verificationSent ? (
            <div className="space-y-4">
              <p className="text-sm text-text-primary">
                Check your inbox: we sent a verification link to <strong>{email}</strong>.
              </p>
              <p className="text-xs text-text-muted">
                The workspace is activated by that link. It is the only proof that the address
                belongs to you, so nobody else can claim it.
              </p>
              <Button type="button" className="w-full" onClick={() => navigate('/')}>
                Go to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                type="text"
                placeholder="Name"
                aria-label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                type="email"
                placeholder="Email"
                aria-label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <label className="flex items-start gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                />
                <span>
                  I accept the{' '}
                  <Link to="/terms" className="underline">
                    Terms of Service
                  </Link>{' '}
                  and I have read the{' '}
                  <Link to="/privacy" className="underline">
                    Privacy Notice
                  </Link>
                  .
                </span>
              </label>
              <label className="flex items-start gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={isAdult}
                  onChange={(e) => setIsAdult(e.target.checked)}
                />
                <span>I confirm that I am at least 18 years old.</span>
              </label>
              {error && (
                <p role="alert" className="text-xs text-danger">
                  {error}
                </p>
              )}
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
