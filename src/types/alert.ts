export enum AlertType {
  RenewalImminent = 'renewal_imminent',
  RenewalCritical = 'renewal_critical',
  RenewalPastDue = 'renewal_past_due',
  ScoreDropped = 'score_dropped',
}

export enum AlertSeverity {
  Info = 'info',
  Warning = 'warning',
  Critical = 'critical',
}

export interface RenewalAlert {
  id?: number;
  domain: string;
  portfolioEntryId: number;
  alertType: AlertType;
  severity: AlertSeverity;
  message: string;
  details?: string | undefined;
  acknowledgedAt?: string | undefined;
  notifiedChannels: string[];
  createdAt?: string | undefined;
}

export interface InsertRenewalAlertInput {
  domain: string;
  portfolioEntryId: number;
  alertType: AlertType;
  severity: AlertSeverity;
  message: string;
  details?: string | undefined;
}

export type AlertChannel = 'console' | 'desktop' | 'webhook' | 'telegram';
