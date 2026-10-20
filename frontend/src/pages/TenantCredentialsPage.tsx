// SPDX-License-Identifier: AGPL-3.0-only
import {
  useTenantCredentials,
  useSetTenantCredential,
  useDeleteTenantCredential,
} from '@/hooks/useTenantCredentials';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { toast } from 'sonner';

const PROVIDER_TYPES: string[] = ['registrar', 'parking', 'adsense', 'gsc', 'marketplace'];

const providerLabels: Record<string, string> = {
  registrar: 'Registrar (DNS write / purchase)',
  parking: 'Parking provider (revenue reports)',
  adsense: 'Google AdSense (monetization)',
  gsc: 'Google Search Console (indexing)',
  marketplace: 'Marketplace API (offer sync)',
};

function providerTypeIcon(type: string): string {
  return (
    {
      registrar: '🔐',
      parking: '🅿️',
      adsense: '💰',
      gsc: '🔍',
      marketplace: '🏪',
    }[type] ?? '🔑'
  );
}

export function TenantCredentialsPage() {
  const { data: credentials = [], isLoading } = useTenantCredentials();
  const setCredential = useSetTenantCredential();
  const deleteCredential = useDeleteTenantCredential();

  const form = {
    providerType: 'registrar' as string,
    providerName: '',
    secret: '',
    accountId: '',
    credentialScope: '',
  };

  const handleSave = async () => {
    if (!form.providerName || !form.secret) {
      toast.error('Provider name and secret are required');
      return;
    }
    try {
      await setCredential.mutateAsync({
        providerType: form.providerType as
          'registrar' | 'parking' | 'adsense' | 'gsc' | 'marketplace',
        providerName: form.providerName,
        input: {
          secret: form.secret,
          accountId: form.accountId || null,
          credentialScope: form.credentialScope || null,
        },
      });
      form.providerName = '';
      form.secret = '';
      form.accountId = '';
      form.credentialScope = '';
    } catch {
      // toast already shown by hook
    }
  };

  const handleDelete = async (providerType: string, providerName: string) => {
    if (
      !window.confirm(
        `Delete the stored credential for ${providerName} (${providerType})? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await deleteCredential.mutateAsync({
        providerType: providerType as 'registrar' | 'parking' | 'adsense' | 'gsc' | 'marketplace',
        providerName,
      });
    } catch {
      // toast already shown by hook
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Provider credentials"
        subtitle="Store per-provider API keys and tokens in the encrypted vault"
      />

      <Card>
        <CardHeader>
          <CardTitle>Add or replace a credential</CardTitle>
          <CardDescription>
            Secrets are encrypted at rest (AES-256-GCM, key from VAULT_ENCRYPTION_KEY) and never
            returned in plaintext. The credential is decrypted only in memory for a single provider
            call.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cred-provider-type">Provider type</Label>
              <Select
                id="cred-provider-type"
                value={form.providerType}
                onChange={(e) => {
                  form.providerType = e.target.value;
                }}
              >
                {PROVIDER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {providerTypeIcon(t)} {providerLabels[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cred-provider-name">Provider name</Label>
              <Input
                id="cred-provider-name"
                placeholder="e.g. cloudflare, sedo, dan"
                value={form.providerName}
                onChange={(e) => {
                  form.providerName = e.target.value;
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cred-secret">Secret (API key / token)</Label>
            <Input
              id="cred-secret"
              type="password"
              placeholder="••••••••"
              value={form.secret}
              onChange={(e) => {
                form.secret = e.target.value;
              }}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cred-account-id">Account ID (optional)</Label>
              <Input
                id="cred-account-id"
                placeholder="vendor account id"
                value={form.accountId}
                onChange={(e) => {
                  form.accountId = e.target.value;
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cred-scope">Scope (optional)</Label>
              <Input
                id="cred-scope"
                placeholder="e.g. dns:edit, adsense:read"
                value={form.credentialScope}
                onChange={(e) => {
                  form.credentialScope = e.target.value;
                }}
              />
            </div>
          </div>
          <Button
            onClick={handleSave}
            disabled={setCredential.isPending || !form.providerName || !form.secret}
          >
            {setCredential.isPending ? 'Storing…' : 'Store credential'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configured credentials</CardTitle>
          <CardDescription>
            Metadata only — secrets are never displayed. Use the vault to rotate or remove
            credentials at any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : credentials.length === 0 ? (
            <EmptyState
              title="No credentials stored yet"
              description="Add a provider credential above to enable automated DNS writes, parking revenue reads, or marketplace offer sync."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-2 font-medium">Provider</th>
                  <th className="py-2 font-medium">Account</th>
                  <th className="py-2 font-medium">Scope</th>
                  <th className="py-2 font-medium">Updated</th>
                  <th className="py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => (
                  <tr
                    key={`${c.providerType}:${c.providerName}`}
                    className="border-t border-border"
                  >
                    <td className="py-2 text-text-primary">
                      {providerTypeIcon(c.providerType)} {c.providerName}
                    </td>
                    <td className="py-2 text-text-secondary">{c.accountId ?? '—'}</td>
                    <td className="py-2 text-text-secondary">{c.credentialScope ?? '—'}</td>
                    <td className="py-2 text-text-muted text-xs">
                      {new Date(c.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="py-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          form.providerType = c.providerType;
                          form.providerName = c.providerName;
                          form.accountId = c.accountId ?? '';
                          form.credentialScope = c.credentialScope ?? '';
                        }}
                        disabled={setCredential.isPending || deleteCredential.isPending}
                      >
                        Replace
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDelete(c.providerType, c.providerName)}
                        disabled={deleteCredential.isPending}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About the vault</CardTitle>
          <CardDescription>How credentials are protected.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <ul className="list-disc list-inside text-sm text-text-muted space-y-1">
            <li>
              Credentials are encrypted with AES-256-GCM before being written to the database. The
              key is derived from VAULT_ENCRYPTION_KEY via scrypt.
            </li>
            <li>
              The secret is decrypted only in memory for the duration of a single provider call and
              never logged.
            </li>
            <li>
              If VAULT_ENCRYPTION_KEY is not set, credential writes are refused (fail-closed) and
              the provider degrades to its env-based configuration.
            </li>
            <li>
              Losing VAULT_ENCRYPTION_KEY means losing access to all stored credentials — back it up
              outside the database.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
