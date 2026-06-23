import { useHealth, useProviders } from '@/hooks/useSettings';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

export function SettingsPage() {
  const { logout } = useAuth();
  const { data: health, isLoading: healthLoading } = useHealth();
  const { data: providers = [], isLoading: providersLoading } = useProviders();

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold text-text-primary">Settings</h2>

      <Card>
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
          <CardDescription>Update your API key or sign out</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input type="password" placeholder="New API Key" />
          <div className="flex gap-2">
            <Button variant="outline" onClick={logout}>
              Sign Out
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>System Health</CardTitle>
              <CardDescription>
                {health ? `v${health.version} · ${health.status}` : 'Loading...'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {healthLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <InfoRow label="Version" value={health?.version ?? '—'} />
              <InfoRow label="Status" value={health?.status ?? '—'} />
              <InfoRow
                label="Uptime"
                value={
                  health?.uptime != null
                    ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m`
                    : '—'
                }
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Providers</CardTitle>
          <CardDescription>External service status</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {providersLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : providers.length === 0 ? (
            <p className="text-sm text-text-muted">No provider status available</p>
          ) : (
            providers.map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between py-2 border-b border-border last:border-0"
              >
                <span className="text-sm text-text-primary">{p.name}</span>
                <Badge variant={p.configured ? 'success' : 'danger'}>
                  {p.configured ? 'Configured' : 'Not configured'}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1.5 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary font-mono">{value}</span>
    </div>
  );
}
