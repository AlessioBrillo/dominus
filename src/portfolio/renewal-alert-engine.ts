import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import type { RenewalAlertRepository } from '../db/repositories/renewal-alert-repository.js';
import { computeRenewalClock } from './renewal-clock.js';
import { AlertType, AlertSeverity } from '../types/alert.js';
import type { InsertRenewalAlertInput, RenewalAlert } from '../types/alert.js';
import type { Config } from '../config.js';
import type { Notifier } from '../notifiers/notifier.js';
import { sendAlert } from '../notifiers/notifier-router.js';

export interface AlertEngineResult {
  generated: number;
  alerts: RenewalAlert[];
}

export class RenewalAlertEngine {
  constructor(
    private readonly portfolioRepo: PortfolioRepository,
    private readonly alertRepo: RenewalAlertRepository,
    private readonly config: Config,
    private readonly notifiers: Notifier[],
  ) {}

  async checkAll(): Promise<AlertEngineResult> {
    const entries = this.portfolioRepo.findAll();
    const alerts: RenewalAlert[] = [];

    for (const entry of entries) {
      if (!entry.renewalDate) continue;

      const clock = computeRenewalClock(entry);
      const input = this.#buildAlertInput(entry.domain, entry.id!, clock.daysUntilRenewal);
      if (input === null) continue;

      const persisted = this.alertRepo.upsert(input, []);
      const channels = await sendAlert(this.notifiers, persisted);

      if (channels.length > 0) {
        const updated = this.alertRepo.upsert(input, channels);
        alerts.push(updated);
      } else {
        alerts.push(persisted);
      }
    }

    return { generated: alerts.length, alerts };
  }

  #buildAlertInput(
    domain: string,
    portfolioEntryId: number,
    daysUntilRenewal: number,
  ): InsertRenewalAlertInput | null {
    if (daysUntilRenewal <= 0) {
      return {
        domain,
        portfolioEntryId,
        alertType: AlertType.RenewalPastDue,
        severity: AlertSeverity.Critical,
        message: `Domain ${domain} renewal is PAST DUE by ${Math.abs(daysUntilRenewal)} day(s)`,
      };
    }
    if (daysUntilRenewal <= this.config.RENEWAL_CRITICAL_DAYS) {
      return {
        domain,
        portfolioEntryId,
        alertType: AlertType.RenewalCritical,
        severity: AlertSeverity.Critical,
        message: `Domain ${domain} renews in ${daysUntilRenewal} day(s) — critical`,
        details: `Renewal in ${daysUntilRenewal} days. Action required.`,
      };
    }
    if (daysUntilRenewal <= this.config.RENEWAL_WARNING_DAYS) {
      return {
        domain,
        portfolioEntryId,
        alertType: AlertType.RenewalImminent,
        severity: AlertSeverity.Warning,
        message: `Domain ${domain} renews in ${daysUntilRenewal} day(s)`,
        details: `Renewal window: ${daysUntilRenewal} days remaining.`,
      };
    }

    return null;
  }
}
