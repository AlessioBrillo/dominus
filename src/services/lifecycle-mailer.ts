// SPDX-License-Identifier: AGPL-3.0-only
import type { Mailer } from '../providers/email/mailer.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export type LifecycleKind = 'welcome' | 'trial_ending' | 'receipt' | 'payment_failed' | 'cancelled';

export interface LifecycleMailerDeps {
  mailer: Mailer | undefined;
  /** The owner's verified email, resolved from the tenant's admin seat. */
  ownerEmail: (tenantId: string) => Promise<string | undefined>;
}

const MESSAGES: Record<LifecycleKind, (detail: string) => { subject: string; text: string }> = {
  welcome: () => ({
    subject: 'Welcome to DOMINUS Cloud',
    text:
      'Your workspace is ready. Import the domains you already own to see their renewal ' +
      'clock and keep/drop verdicts.\n\nThe trial lasts 14 days. We do not charge you before it ends.\n',
  }),
  trial_ending: () => ({
    subject: 'Your DOMINUS trial ends soon',
    text:
      'Your 14-day trial is about to end. Unless you cancel, the subscription becomes ' +
      'paid at the price shown at checkout. You can manage or cancel it in Billing.\n',
  }),
  receipt: (detail) => ({
    subject: 'Your DOMINUS receipt',
    text: `A payment for ${detail} has been received. The invoice is in your Stripe account.\n`,
  }),
  payment_failed: () => ({
    subject: 'Action needed: your DOMINUS payment failed',
    text:
      'We could not charge your payment method. Paid capacity is limited to the free plan ' +
      'until the payment succeeds. Update the card in Billing to restore your workspace.\n',
  }),
  cancelled: () => ({
    subject: 'Your DOMINUS subscription has been cancelled',
    text:
      'Your subscription is cancelled. Your data remains available until its retention ' +
      'window ends, and you can export it from Settings at any time.\n',
  }),
};

/**
 * Transactional mail for the states a payment provider can put a customer
 * into. A `past_due` row in the database is invisible to the customer; the
 * email is what turns a silent failure into an action.
 *
 * Delivery is best-effort: a mail failure must never make Stripe redeliver
 * an event that already changed local state. The webhook dedup already makes
 * one event one email.
 */
export class LifecycleMailer {
  constructor(private readonly deps: LifecycleMailerDeps) {}

  async send(kind: LifecycleKind, tenantId: string, detail = 'your subscription'): Promise<void> {
    if (!this.deps.mailer?.configured) return;
    let email: string | undefined;
    try {
      email = await this.deps.ownerEmail(tenantId);
    } catch (error) {
      logger.warn({ error, tenantId, kind }, 'Could not resolve the billing email');
      return;
    }
    if (!email) return;

    try {
      const message = MESSAGES[kind](detail);
      await this.deps.mailer.send({ to: email, subject: message.subject, text: message.text });
    } catch (error) {
      logger.warn({ error, tenantId, kind }, 'Lifecycle email could not be delivered');
    }
  }
}
