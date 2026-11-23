// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from 'react-router-dom';
import { joinWaitlist } from '@/api/waitlist';

/**
 * First-party waitlist: the consent version is sent with the address, so the
 * operator can prove which privacy notice the person accepted and when.
 * Confirmation is by double opt-in; the address is not stored as confirmed
 * until the link in the email is opened.
 */
export function WaitlistForm({ consentVersion }: { consentVersion: string }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim()) {
      setState('error');
      setMessage('Enter an email address');
      return;
    }
    setState('sending');
    try {
      await joinWaitlist(email.trim(), consentVersion);
      setState('sent');
    } catch (err: unknown) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'The request could not be sent');
    }
  };

  return (
    <div className="mt-6 max-w-md">
      {state === 'sent' ? (
        <p role="status" className="text-sm text-text-secondary">
          Check your inbox. The address is stored only after you open the confirmation link.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label htmlFor="waitlist-email" className="block text-sm text-text-secondary">
            Email address
            <Input
              id="waitlist-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          <p className="text-xs text-text-muted">
            By submitting you consent to be contacted about the hosted edition, under the{' '}
            <Link to="/privacy" className="underline">
              Privacy Notice
            </Link>
            . No account is created and no seat, price or launch date is reserved.
          </p>
          {state === 'error' && (
            <p role="alert" className="text-sm text-red-500">
              {message}
            </p>
          )}
          <Button type="submit" disabled={state === 'sending'}>
            {state === 'sending' ? 'Sending…' : 'Join the waitlist'}
          </Button>
        </form>
      )}
    </div>
  );
}
