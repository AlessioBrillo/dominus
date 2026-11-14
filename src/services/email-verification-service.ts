// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import type { SignupVerificationRepository } from '../db/repositories/signup-verification-repository.js';
import type { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import type { GeneratedKeyResult, KeyManager } from '../providers/auth/auth-provider.js';
import type { Mailer } from '../providers/email/mailer.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

/** The token is unknown, expired, already used, or points at nothing. */
export class VerificationInvalidError extends Error {
  readonly code = 'VERIFICATION_INVALID';
  readonly context: Record<string, unknown>;

  constructor(
    message = 'The verification link is invalid or has expired',
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'VerificationInvalidError';
    this.context = context;
  }
}

/** The email could not be delivered: no transport is configured. */
export class VerificationDeliveryError extends Error {
  readonly code = 'VERIFICATION_DELIVERY_FAILED';
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'VerificationDeliveryError';
    this.context = context;
  }
}

export interface EmailVerificationDeps {
  verifications: SignupVerificationRepository;
  seats: TeamSeatsRepository;
  /** Mints the API key of the workspace. Absent = no key can be issued. */
  keyManager?: KeyManager | undefined;
  /** The mail transport. Absent or unconfigured = no email can be sent. */
  mailer?: Mailer | undefined;
  /** Public origin of the SPA, used to build the link (PUBLIC_APP_URL). */
  appUrl?: string | undefined;
  /** Lifetime of a signup token, in hours (default 24). */
  signupTtlHours?: number;
  /** Lifetime of a recovery token, in hours (default 1). */
  recoveryTtlHours?: number;
}

export interface IssuedVerification {
  /** The single-use token. Never logged, never stored in clear. */
  token: string;
  /** The link the user has to open. */
  link: string;
}

export interface VerifiedWorkspace {
  tenantId: string;
  key: GeneratedKeyResult;
}

const DEFAULT_SIGNUP_TTL_HOURS = 24;
const DEFAULT_RECOVERY_TTL_HOURS = 1;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Proves that the person who signed up owns the mailbox they wrote down.
 *
 * The signup used to hand an admin API key to whoever typed an address, and
 * the single-sign-on resolver used to re-link the seat of that address to
 * the first identity provider subject that presented it: whoever typed the
 * address of a colleague created the workspace, and the colleague inherited
 * it (and the colleague's attacker kept the key).
 *
 * The flow is now:
 *
 *   1. `POST /auth/register` creates the workspace, the PENDING seat and a
 *      single-use token; no key is issued.
 *   2. The link is emailed to the address. Only the owner of the mailbox
 *      can open it.
 *   3. `POST /auth/verify-email` consumes the token (once), activates the
 *      seat, records that the address is proven, REVOKES the keys that
 *      existed before the proof, and issues a fresh one.
 *
 * Step 3 is what makes the takeover impossible in both directions: a
 * workspace created with somebody else's address cannot be claimed by that
 * somebody while the first writer keeps a working key.
 */
export class EmailVerificationService {
  readonly #deps: EmailVerificationDeps;

  constructor(deps: EmailVerificationDeps) {
    this.#deps = deps;
  }

  /** Whether an email can be sent at all. */
  get canDeliver(): boolean {
    return this.#deps.mailer?.configured === true;
  }

  /** Whether a key can be minted at all. */
  get canIssueKeys(): boolean {
    return this.#deps.keyManager !== undefined;
  }

  /**
   * Issue the token that proves the ownership of the address, and send it.
   *
   * The delivery is the security boundary: a token that never reaches the
   * mailbox proves nothing, so the caller must fail closed when the mail
   * transport is missing instead of handing the token to the requester.
   */
  async issueSignupVerification(input: {
    tenantId: string;
    email: string;
    name: string;
  }): Promise<IssuedVerification> {
    const token = randomBytes(32).toString('base64url');
    const ttlHours = this.#deps.signupTtlHours ?? DEFAULT_SIGNUP_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();

    await this.#deps.verifications.create({
      tenantId: input.tenantId,
      email: input.email,
      tokenHash: hashToken(token),
      purpose: 'signup',
      expiresAt,
    });

    const link = this.#buildLink('verify-email', token);
    await this.#deliver(input.email, input.name, 'Verify your DOMINUS workspace', link, ttlHours);
    return { token, link };
  }

  /**
   * Consume a signup token: activate the seat, mark the address as proven,
   * revoke the keys issued before the proof, and mint a new one.
   */
  async verifySignup(token: string): Promise<VerifiedWorkspace> {
    const verification = await this.#consume(token, 'signup');
    const seat = await this.#deps.seats.findByTenantAndUser(
      verification.tenantId,
      verification.email,
    );
    if (!seat) throw new VerificationInvalidError();
    // A seat that an operator removed in the meantime is not reactivated by
    // a link: the removal is a decision, the link is only a proof.
    if (seat.status === 'removed') throw new VerificationInvalidError();

    await this.#deps.seats.acceptInvite(verification.tenantId, verification.email);
    await this.#deps.seats.markEmailVerified(verification.tenantId, verification.email);

    // Everything issued before the proof belonged to whoever created the
    // workspace, not necessarily to the owner of the mailbox.
    const revoked = await this.#deps.keyManager?.revokeAll(verification.tenantId);
    if (revoked !== undefined && revoked > 0) {
      logger.info(
        { tenantId: verification.tenantId, revoked },
        'EmailVerificationService: keys issued before the email verification were revoked',
      );
    }

    const key = await this.#mintKey(verification.tenantId, 'DOMINUS workspace');
    return { tenantId: verification.tenantId, key };
  }

  /**
   * Send a new signup link to an address that has not been proven yet.
   *
   * The answer is the same whether the address exists or not: the endpoint
   * must not become an oracle that tells a stranger which mailboxes have an
   * account.
   *
   * EVERY unverified workspace of the address gets its own link: the same
   * address may have created more than one workspace, and the owner of the
   * mailbox must be able to prove each of them.
   */
  async resendSignupVerification(email: string): Promise<boolean> {
    const seats = await this.#deps.seats.findByUserId(email);
    const unverified = seats.filter((s) => s.emailVerifiedAt === null);
    if (unverified.length === 0) return false;

    const ttlHours = this.#deps.signupTtlHours ?? DEFAULT_SIGNUP_TTL_HOURS;
    for (const seat of unverified) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();

      await this.#deps.verifications.create({
        tenantId: seat.tenantId,
        email,
        tokenHash: hashToken(token),
        purpose: 'signup',
        expiresAt,
      });

      const link = this.#buildLink('verify-email', token);
      await this.#deliver(email, 'DOMINUS', 'Verify your DOMINUS workspace', link, ttlHours);
    }
    return true;
  }

  /**
   * Send a recovery link to the owner of a verified address.
   *
   * The answer never says whether the address exists: the endpoint must not
   * become an oracle that tells a stranger which mailboxes have an account.
   */
  async requestRecovery(email: string): Promise<boolean> {
    const seats = await this.#deps.seats.findByUserId(email);
    const verified = seats.filter((s) => s.emailVerifiedAt !== null && s.status === 'active');
    const seat = verified[0];
    if (!seat) return false;
    if (verified.length > 1) {
      logger.warn(
        { email, tenants: verified.map((s) => s.tenantId) },
        'EmailVerificationService: several workspaces share this address — the most recent one is recovered',
      );
    }

    const token = randomBytes(32).toString('base64url');
    const ttlHours = this.#deps.recoveryTtlHours ?? DEFAULT_RECOVERY_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();

    await this.#deps.verifications.create({
      tenantId: seat.tenantId,
      email,
      tokenHash: hashToken(token),
      purpose: 'recovery',
      expiresAt,
    });

    const link = this.#buildLink('recover', token);
    await this.#deliver(email, 'DOMINUS', 'Recover your DOMINUS API key', link, ttlHours);
    return true;
  }

  /**
   * Consume a recovery token and issue a new key.
   *
   * The other keys are NOT revoked: the recovery exists because a key was
   * lost, and the surviving keys may be the machine credentials of the
   * customer's CI. The user revokes them from the settings when they want.
   */
  async confirmRecovery(token: string): Promise<VerifiedWorkspace> {
    const verification = await this.#consume(token, 'recovery');
    const key = await this.#mintKey(verification.tenantId, 'DOMINUS workspace (recovered)');
    return { tenantId: verification.tenantId, key };
  }

  async #consume(
    token: string,
    purpose: 'signup' | 'recovery',
  ): Promise<{ tenantId: string; email: string }> {
    const verification = await this.#deps.verifications.findByTokenHash(hashToken(token));
    if (!verification || verification.purpose !== purpose) {
      throw new VerificationInvalidError();
    }
    if (verification.consumedAt !== null) throw new VerificationInvalidError();
    if (new Date(verification.expiresAt).getTime() <= Date.now()) {
      throw new VerificationInvalidError();
    }
    const consumed = await this.#deps.verifications.consume(verification.id);
    if (!consumed) throw new VerificationInvalidError();
    return verification;
  }

  async #mintKey(tenantId: string, name: string): Promise<GeneratedKeyResult> {
    const keyManager = this.#deps.keyManager;
    if (!keyManager) {
      throw new VerificationInvalidError('API key management is not available');
    }
    return keyManager.generate({ tenantId, name, role: 'admin' });
  }

  #buildLink(path: string, token: string): string {
    const base = (this.#deps.appUrl ?? '').replace(/\/+$/, '');
    return `${base}/${path}?token=${encodeURIComponent(token)}`;
  }

  async #deliver(
    to: string,
    name: string,
    subject: string,
    link: string,
    ttlHours: number,
  ): Promise<void> {
    const mailer = this.#deps.mailer;
    if (!mailer || !mailer.configured) {
      throw new VerificationDeliveryError(
        'Email is not configured: set SMTP_URL to deliver the verification link',
      );
    }
    await mailer.send({
      to,
      subject,
      text:
        `Hello ${name},\n\n` +
        `Confirm that this address belongs to you (valid for ${Math.round(ttlHours)} hour(s)):\n` +
        `${link}\n\n` +
        `If you did not request this, ignore this email: nothing happens until the link is opened.`,
    });
  }
}
