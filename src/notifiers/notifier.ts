import type { Notification } from '../types/alert.js';

export const NOTIFIER_CHANNELS = ['console', 'desktop', 'webhook', 'telegram'] as const;
export type NotifierChannel = (typeof NOTIFIER_CHANNELS)[number];

export interface Notifier {
  readonly channel: NotifierChannel;
  send(alert: Notification): Promise<void>;
}
