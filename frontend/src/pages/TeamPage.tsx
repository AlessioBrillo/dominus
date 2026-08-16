// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useTeamSummary,
  useInviteMember,
  useUpdateMemberRole,
  useRemoveMember,
} from '@/hooks/useTeam';

export function TeamPage() {
  const { data: team, isLoading } = useTeamSummary();
  const invite = useInviteMember();
  const updateRole = useUpdateMemberRole();
  const remove = useRemoveMember();

  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [error, setError] = useState('');

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) {
      setError('User ID is required');
      return;
    }
    setError('');
    invite.mutate(
      { userId: userId.trim(), role },
      {
        onError: () => setError('Invite failed — check the seat limit and user ID'),
      },
    );
    if (!error) setUserId('');
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
            <p className="text-2xl font-semibold">{team.pendingSeats}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite member</CardTitle>
          <CardDescription>
            Send an invite by user ID (email) — the invite occupies a seat once accepted
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <Input
                type="text"
                placeholder="user@example.com"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
            </div>
            <div className="flex gap-1">
              {(['member', 'admin'] as const).map((r) => (
                <Button
                  key={r}
                  type="button"
                  variant={role === r ? 'default' : 'outline'}
                  size="sm"
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
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </CardContent>
      </Card>

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
