export enum AlertType {
  RenewalImminent = 'renewal_imminent',
  RenewalCritical = 'renewal_critical',
  RenewalPastDue = 'renewal_past_due',
  ScoreDropped = 'score_dropped',
  DomainAvailable = 'domain_available',
  SystemError = 'system_error',
}

export enum AlertSeverity {
  Info = 'info',
  Warning = 'warning',
  Critical = 'critical',
  Success = 'success',
}

export interface Notification {
  domain: string;
  alertType: AlertType;
  severity: AlertSeverity;
  message: string;
  details?: string | undefined;
  createdAt?: string | undefined;
}

export interface RenewalAlert extends Notification {
  id?: number;
  portfolioEntryId: number;
  acknowledgedAt?: string | undefined;
  notifiedChannels: string[];
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
