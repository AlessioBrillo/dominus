// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import type { Mailer } from '../providers/email/mailer.js';
import type { WaitlistSignupRepository } from '../db/repositories/waitlist-signup-repository.js';

/**
 * The waitlist, operated by the project instead of a third-party form.
 *
 * The privacy notice promises a consent version, a timestamp and a double
 * opt-in. An external URL cannot provide those; this service can, and it
 * refuses to collect an address when no mailer is configured, because an
 * unconfirmable signup is worse than no signup.
 */
export class WaitlistService {
  constructor(
    private readonly repo: WaitlistSignupRepository,
    private readonly mailer: Mailer | undefined,
    private readonly siteUrl: string | undefined,
    private readonly privacyEmail: string | undefined,
  ) {}

  get canAccept(): boolean {
    return this.mailer?.configured === true;
  }

  async subscribe(email: string, consentVersion: string): Promise<void> {
    if (!this.canAccept || !this.mailer) {
      throw new Error('WAITLIST_UNAVAILABLE');
    }
    const address = email.trim().toLowerCase();
    // A second submit is not an error: the first confirmation email is
    // already on its way and the consent record already exists.
    if (await this.repo.findByEmail(address)) return;
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.repo.create({ email: address, consentVersion, tokenHash });
    const origin = this.siteUrl?.replace(/\/$/, '') ?? '';
    const withdrawLink = `${origin}/public/waitlist/withdraw?token=${encodeURIComponent(token)}`;
    const link = `${origin}/public/waitlist/confirm?token=${encodeURIComponent(token)}`;
    try {
      await this.mailer.send({
        to: address,
        subject: 'Confirm your DOMINUS Cloud waitlist registration',
        text:
          `You asked to be told when DOMINUS Cloud opens. Confirm this address by opening:\n\n` +
          `${link}\n\n` +
          `The consent you gave has version ${consentVersion}. You can withdraw it at any time ` +
          `with this link: ${withdrawLink} or by writing to ` +
          `${this.privacyEmail ?? 'the data protection contact in the privacy notice'}.\n\n` +
          `Registering does not create a contract and does not reserve a seat, a price or a launch date.\n`,
      });
    } catch (err) {
      // Do not leave an address we could never confirm: a retry must be able
      // to start again from a clean state.
      await this.repo.deleteForEmail(address);
      throw err;
    }
  }

  /** Withdrawal uses the same single-use token that was emailed to the person. */
  async withdraw(token: string): Promise<boolean> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.repo.deleteByTokenHash(tokenHash);
  }

  async confirm(token: string): Promise<boolean> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.repo.confirm(tokenHash);
  }

  async countConfirmed(): Promise<number> {
    return this.repo.countConfirmed();
  }
}
