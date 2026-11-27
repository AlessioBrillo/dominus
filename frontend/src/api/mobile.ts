// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export interface TodayDecision {
  id: string;
  type: 'alert' | 'renewal' | 'watchlist';
  domain: string;
  title: string;
  detail: string;
  severity: 'critical' | 'warning' | 'info' | string;
  href: string;
}

export interface TodayResponse {
  generatedAt: string;
  decisions: TodayDecision[];
  summary: {
    portfolioDomains: number;
    activeAlerts: number;
    watchlistSize: number;
  };
  /** ADR-0115: the value contract states its evidence, never a bare price. */
  evidence: {
    marketDataAvailable: boolean;
    note: string;
  };
}

export interface DeviceView {
  id: number;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface PushSubscriptionView {
  id: number;
  platform: 'web' | 'android' | 'ios' | string;
  topics: { renewal: boolean; watchlist: boolean; verdict: boolean };
  createdAt: string;
}

export interface PushStatus {
  vapidPublicKey: string | null;
  enabled: boolean;
  subscriptions: PushSubscriptionView[];
}

export const fetchToday = (signal?: AbortSignal): Promise<TodayResponse> =>
  api.get<TodayResponse>('/mobile/today', signal);

export const listDevices = (): Promise<{ devices: DeviceView[] }> =>
  api.get<{ devices: DeviceView[] }>('/mobile/devices');

export const createDevice = (label: string): Promise<{ device: DeviceView; token: string }> =>
  api.post<{ device: DeviceView; token: string }>('/mobile/devices', { label });

export const revokeDevice = (id: number): Promise<{ revoked: boolean }> =>
  api.delete<{ revoked: boolean }>(`/mobile/devices/${id}`);

export const fetchPushStatus = (): Promise<PushStatus> => api.get<PushStatus>('/mobile/push');

export const subscribePush = (input: {
  platform: 'web' | 'android' | 'ios';
  endpoint: string;
  p256dh?: string;
  auth?: string;
  topics: { renewal: boolean; watchlist: boolean; verdict: boolean };
}): Promise<{ subscription: PushSubscriptionView }> =>
  api.put<{ subscription: PushSubscriptionView }>('/mobile/push', input);

export const unsubscribePush = (id: number): Promise<{ removed: boolean }> =>
  api.delete<{ removed: boolean }>(`/mobile/push/${id}`);
