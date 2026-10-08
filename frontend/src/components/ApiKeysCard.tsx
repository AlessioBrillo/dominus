// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/api/client';
import type { CreatedApiKey } from '@/api/keys';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/hooks/useApiKeys';

function createErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'SEAT_LIMIT_EXCEEDED') return 'Your plan has no room for another key.';
    if (err.status === 403) return 'Only admins can create keys.';
  }
  return 'Could not create the key. Try again.';
}

/**
 * Machine credentials for the CLI and scripts. People sign in with SSO; keys
 * are for automation. Hidden where the server does not manage keys (community
 * edition reads them from the environment) or the caller is not an admin.
 */
export function ApiKeysCard() {
  const { data: keys, isLoading, error } = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();

  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [formError, setFormError] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Give the key a name');
      return;
    }
    setFormError('');
    setCreated(null);
    create.mutate(
      { name: trimmed, role },
      {
        onSuccess: (result) => {
          setCreated(result);
          setName('');
        },
        onError: (err) => setFormError(createErrorMessage(err)),
      },
    );
  };

  const copy = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success('Key copied');
    } catch {
      toast.error('Could not copy. Select the key and copy it manually.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          Credentials for the CLI and scripts. A key is shown once, when you create it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <label htmlFor="api-key-name" className="sr-only">
              Key name
            </label>
            <Input
              id="api-key-name"
              placeholder="e.g. ci-pipeline"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? 'api-key-error' : undefined}
            />
          </div>
          <div className="flex gap-1" role="group" aria-label="Key role">
            {(['member', 'admin'] as const).map((r) => (
              <Button
                key={r}
                type="button"
                size="sm"
                variant={role === r ? 'default' : 'outline'}
                aria-pressed={role === r}
                onClick={() => setRole(r)}
              >
                {r}
              </Button>
            ))}
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating...' : 'Create key'}
          </Button>
        </form>
        {formError && (
          <p id="api-key-error" role="alert" className="text-xs text-danger">
            {formError}
          </p>
        )}

        {created && (
          <div role="status" className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Copy your key now. You will not see it again.</p>
            <div className="mt-2 flex items-center gap-2">
              <Input readOnly aria-label="New API key" value={created.key} className="font-mono" />
              <Button type="button" size="sm" onClick={() => void copy(created.key)}>
                Copy
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : keys && keys.length > 0 ? (
          <ul className="divide-y divide-border">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{k.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <code className="text-xs text-text-muted">{k.prefix}…</code>
                    <Badge variant="outline">{k.role}</Badge>
                    <span className="text-xs text-text-muted">
                      {k.lastUsedAt
                        ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                        : 'never used'}
                    </span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revoke.isPending}
                  aria-label={`Revoke key ${k.name}`}
                  onClick={() => revoke.mutate(k.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No API keys yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
