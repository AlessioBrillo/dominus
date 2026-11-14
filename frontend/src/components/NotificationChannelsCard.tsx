// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface NotificationSettings {
  tenantId: string;
  email: string | null;
  hasWebhook: boolean;
  telegramChatId: string | null;
  enabled: boolean;
}

/**
 * The notification channels of the workspace.
 *
 * The alerts of the domains (the renewal, the drop verdict, the domain that
 * became available) go to these channels. They are the channels of the
 * customer: the operator's webhook and Telegram chat are not a substitute.
 */
export function NotificationChannelsCard() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['tenant', 'notifications'],
    queryFn: () => api.get<NotificationSettings>('/tenant/notifications'),
  });

  const save = useMutation({
    mutationFn: () =>
      api.put<NotificationSettings>('/tenant/notifications', {
        email: email.trim() || null,
        webhookUrl: webhookUrl.trim() || null,
        telegramChatId: telegramChatId.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenant', 'notifications'] });
      toast.success('Notification channels saved');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const test = useMutation({
    mutationFn: () => api.post<{ channels: string[] }>('/tenant/notifications/test'),
    onSuccess: (result) => toast.success(`Test sent to: ${result.channels.join(', ')}`),
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>Where the alerts of your domains are delivered</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Where the alerts of your domains are delivered</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="notifications-email" className="text-xs font-medium text-text-muted">
            Email
          </label>
          <Input
            id="notifications-email"
            type="email"
            placeholder={data?.email ?? 'alerts@example.com'}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="notifications-webhook" className="text-xs font-medium text-text-muted">
            Webhook URL
          </label>
          <Input
            id="notifications-webhook"
            type="url"
            placeholder={data?.hasWebhook ? '•••••• (stored)' : 'https://example.com/hook'}
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="notifications-telegram" className="text-xs font-medium text-text-muted">
            Telegram chat id
          </label>
          <Input
            id="notifications-telegram"
            type="text"
            placeholder={data?.telegramChatId ?? '123456789'}
            value={telegramChatId}
            onChange={(e) => setTelegramChatId(e.target.value)}
          />
        </div>

        <div className="flex gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save channels'}
          </Button>
          <Button
            variant="outline"
            onClick={() => test.mutate()}
            disabled={test.isPending || !data}
          >
            {test.isPending ? 'Sending…' : 'Send a test'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
