// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/api/client';
import { acceptInvitation } from '@/api/team';
import { forgetInvite } from '@/lib/pending-invite';

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVITATION_INVALID')
      return 'This invitation is invalid, expired or has already been used. Ask for a new one.';
    if (err.code === 'INVITATION_EMAIL_MISMATCH')
      return 'This invitation was sent to a different email address. Sign in with the invited address (it must be verified at your identity provider).';
    if (err.code === 'SEAT_LIMIT_EXCEEDED')
      return 'The team has no free seat right now. Ask an admin to free one, then try again.';
    if (err.status === 401 || err.status === 404)
      return 'Accepting an invitation requires signing in with single sign-on.';
  }
  return 'Could not accept the invitation. Try again.';
}

/**
 * Landing page of an invitation link (/invite/:token). Sits inside the Layout,
 * so an unauthenticated visitor first sees the sign-in screen; the token is
 * parked in sessionStorage and the user is brought back here after SSO.
 */
export function InvitePage() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const [joined, setJoined] = useState(false);

  const accept = useMutation({
    mutationFn: () => acceptInvitation(token),
    onSuccess: () => {
      forgetInvite();
      // The session now points at the team's tenant: drop everything cached for the old one.
      queryClient.clear();
      setJoined(true);
    },
    onError: (err) => {
      // An invalid/used link will never work again; do not bounce the user back here.
      if (err instanceof ApiError && err.code === 'INVITATION_INVALID') forgetInvite();
    },
  });

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader title="Team invitation" subtitle="Join a DOMINUS team" />
      <Card>
        <CardHeader>
          <CardTitle>{joined ? 'You are in' : 'Accept the invitation'}</CardTitle>
          <CardDescription>
            {joined
              ? 'You have joined the team. Your workspace now shows its data.'
              : 'You were invited to share a team workspace. Accepting uses one seat.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {joined ? (
            <Button onClick={() => window.location.assign('/')}>Go to dashboard</Button>
          ) : (
            <Button onClick={() => accept.mutate()} disabled={accept.isPending || token === ''}>
              {accept.isPending ? 'Joining...' : 'Accept invitation'}
            </Button>
          )}
          {accept.isError && (
            <p role="alert" className="text-sm text-danger">
              {describe(accept.error)}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
