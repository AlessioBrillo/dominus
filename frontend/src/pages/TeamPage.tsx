// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/api/client';
import type { InviteResult } from '@/api/team';
import {
  useTeamSummary,
  useInviteMember,
  useRevokeInvitation,
  useUpdateMemberRole,
  useRemoveMember,
} from '@/hooks/useTeam';

function inviteErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'SEAT_LIMIT_EXCEEDED')
      return 'No seats left on your plan. Revoke an invitation or upgrade.';
    if (err.code === 'VALIDATION_ERROR') return 'Enter a valid email address.';
    if (err.status === 403) return 'Only team admins can invite members.';
  }
  return 'Invite failed. Try again.';
}

export function TeamPage() {
  const { data: team, isLoading } = useTeamSummary();
  const invite = useInviteMember();
  const revoke = useRevokeInvitation();
  const updateRole = useUpdateMemberRole();
  const remove = useRemoveMember();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<InviteResult | null>(null);

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Email is required');
      return;
    }
    setError('');
    setCreated(null);
    invite.mutate(
      { email: trimmed, role },
      {
        onSuccess: (result) => {
          setCreated(result);
          setEmail('');
        },
        onError: (err) => setError(inviteErrorMessage(err)),
      },
    );
  };

  const copyLink = async (link: string) => {
    // A relative link (no PUBLIC_APP_URL on the server) still works from this origin.
    const absolute = link.startsWith('http') ? link : `${window.location.origin}${link}`;
    try {
      await navigator.clipboard.writeText(absolute);
      toast.success('Invitation link copied');
    } catch {
      toast.error('Could not copy. Select the link and copy it manually.');
    }
  };

  if (isLoading || !team) {
    return (
      <div className="space-y-4">
        <PageHeader title="Team" subtitle="Seats and members" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const seatLabel = team.seatLimit === null ? 'Unlimited' : `${team.seatLimit} seats`;
  const invitations = team.invitations ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Team" subtitle="Manage members and seats" />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-text-muted">Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold capitalize">{team.plan}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-text-muted">Seats</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {team.activeSeats}
              <span className="text-sm font-normal text-text-muted"> / {seatLabel}</span>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-text-muted">Pending invites</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{team.pendingSeats + invitations.length}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite member</CardTitle>
          <CardDescription>
            We send a single-use link to their email. A pending invitation holds a seat until it is
            accepted, revoked or expires.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <label htmlFor="invite-email" className="sr-only">
                Email address
              </label>
              <Input
                id="invite-email"
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'invite-error' : undefined}
              />
            </div>
            <div className="flex gap-1" role="group" aria-label="Role">
              {(['member', 'admin'] as const).map((r) => (
                <Button
                  key={r}
                  type="button"
                  variant={role === r ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={role === r}
                  onClick={() => setRole(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? 'Inviting...' : 'Invite'}
            </Button>
          </form>
          {error && (
            <p id="invite-error" role="alert" className="mt-2 text-xs text-danger">
              {error}
            </p>
          )}

          {created && (
            <div role="status" className="mt-4 rounded-lg border border-border p-3 text-sm">
              <p className="font-medium">
                {created.emailed
                  ? `Invitation emailed to ${created.invitation.email}.`
                  : `Invitation created for ${created.invitation.email}. Email is not configured, so share this link yourself.`}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                This link is shown once and works for one person.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Input readOnly aria-label="Invitation link" value={created.link} />
                <Button type="button" size="sm" onClick={() => void copyLink(created.link)}>
                  Copy link
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{inv.email}</p>
                    <div className="mt-1 flex gap-2">
                      <Badge variant="warning">pending</Badge>
                      <Badge variant="outline">{inv.role}</Badge>
                      <span className="text-xs text-text-muted">
                        expires {new Date(inv.expiresAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revoke.isPending}
                    aria-label={`Revoke invitation for ${inv.email}`}
                    onClick={() => revoke.mutate(inv.id)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          {team.members.length === 0 ? (
            <p className="text-sm text-text-muted">No members yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {team.members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{m.userId}</p>
                    <div className="mt-1 flex gap-2">
                      <Badge variant={m.status === 'active' ? 'success' : 'warning'}>
                        {m.status}
                      </Badge>
                      <Badge variant="outline">{m.role}</Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updateRole.isPending}
                      onClick={() =>
                        updateRole.mutate({
                          userId: m.userId,
                          role: m.role === 'admin' ? 'member' : 'admin',
                        })
                      }
                    >
                      Make {m.role === 'admin' ? 'member' : 'admin'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={remove.isPending}
                      aria-label={`Remove ${m.userId}`}
                      onClick={() => remove.mutate(m.userId)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
