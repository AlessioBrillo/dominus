// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Link2, LogOut, Smartphone, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  createDevice,
  fetchPushStatus,
  listDevices,
  revokeDevice,
  subscribePush,
  unsubscribePush,
} from '@/api/mobile';
import { IS_STORE_BUILD, getStoredDeviceToken, storeDeviceToken } from '@/api/client';
import { toApplicationServerKey } from '@/lib/web-push';
import { useAuth } from '@/hooks/useAuth';
import { DataRightsCard } from '@/components/DataRightsCard';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Account is the fifth mobile destination (ADR-0114) and holds the
 *  store-compliant controls: durable credential, push opt-in and erasure. */
export function AccountPage() {
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState(false);
  const [topics, setTopics] = useState({ renewal: true, watchlist: true, verdict: true });

  const devices = useQuery({ queryKey: ['mobile', 'devices'], queryFn: listDevices });
  const push = useQuery({ queryKey: ['mobile', 'push'], queryFn: fetchPushStatus });

  const addDevice = useMutation({
    mutationFn: () => createDevice('This device'),
    onSuccess: ({ token }) => {
      storeDeviceToken(token);
      setCreated(true);
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'devices'] });
      toast.success('This device can now stay signed in');
    },
    onError: () => toast.error('Could not add this device'),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => revokeDevice(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'devices'] });
      toast.success('Device removed');
    },
  });

  const enablePush = useMutation({
    mutationFn: async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Push is not supported by this browser');
      }
      const key = push.data?.vapidPublicKey;
      if (!key) throw new Error('Push is not configured on this server');
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('Reload the page once to enable notifications');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toApplicationServerKey(key),
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('The browser did not return a complete subscription');
      }
      return subscribePush({
        platform: 'web',
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        ...(getStoredDeviceToken() ? { deviceToken: getStoredDeviceToken()! } : {}),
        topics,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'push'] });
      toast.success('Renewal alerts will reach this device');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const unsubscribe = useMutation({
    mutationFn: (id: number) => unsubscribePush(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'push'] });
      toast.success('Notifications turned off');
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="Account" subtitle="This workspace, this device, your data" />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4" aria-hidden="true" /> Devices
          </CardTitle>
          <CardDescription>
            A device token survives restarts and can be revoked here at any time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => addDevice.mutate()} disabled={addDevice.isPending}>
            <Link2 className="h-4 w-4 mr-2" /> Add this device
          </Button>
          {created && (
            <p className="text-xs text-success" role="status">
              This device is signed in. The token is stored in secure storage where available.
            </p>
          )}
          {devices.isLoading && <Skeleton className="h-10 w-full" />}
          <ul className="space-y-2">
            {devices.data?.devices.map((device) => (
              <li
                key={device.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{device.label}</span>
                  <span className="block text-xs text-text-muted">
                    {device.revokedAt ? 'Revoked' : `Added ${device.createdAt}`}
                  </span>
                </span>
                {!device.revokedAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revoke.mutate(device.id)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4" aria-hidden="true" /> Notifications
          </CardTitle>
          <CardDescription>
            Renewal clock, watchlist changes and portfolio verdicts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {push.isLoading && <Skeleton className="h-10 w-full" />}
          {push.data?.enabled === false && (
            <p className="text-sm text-text-muted">
              Push is not configured on this server. Alerts remain available in the Alerts tab.
            </p>
          )}
          {push.data?.enabled === true && push.data.subscriptions.length === 0 && (
            <>
              <fieldset className="flex flex-wrap gap-4 text-sm">
                <legend className="sr-only">Alert topics</legend>
                {(['renewal', 'watchlist', 'verdict'] as const).map((topic) => (
                  <label key={topic} className="flex items-center gap-2 capitalize">
                    <input
                      type="checkbox"
                      checked={topics[topic]}
                      onChange={(event) =>
                        setTopics((current) => ({ ...current, [topic]: event.target.checked }))
                      }
                    />
                    {topic}
                  </label>
                ))}
              </fieldset>
              <Button onClick={() => enablePush.mutate()} disabled={enablePush.isPending}>
                Enable notifications
              </Button>
            </>
          )}
          {push.data?.subscriptions.map((subscription) => (
            <div
              key={subscription.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="text-success" role="status">
                On ·{' '}
                {Object.keys(subscription.topics)
                  .filter((k) => subscription.topics[k as keyof typeof subscription.topics])
                  .join(', ') || 'no topics'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => unsubscribe.mutate(subscription.id)}
                disabled={unsubscribe.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Turn off
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <DataRightsCard />

      {!IS_STORE_BUILD && (
        <Card>
          <CardContent className="pt-6">
            <Button variant="outline" asChild>
              <Link to="/billing">Manage plan on the web</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Button variant="ghost" onClick={logout} className="text-danger">
        <LogOut className="h-4 w-4 mr-2" /> Sign out
      </Button>
    </div>
  );
}
