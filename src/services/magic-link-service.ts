// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import type { MagicLinkTokenRepository } from '../db/repositories/magic-link-token-repository.js';
import type { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import type { Mailer } from '../providers/email/mailer.js';
import type { IdentityTenantResolver } from './identity-tenant-resolver.js';

export interface MagicLinkSessionClaims {
  sub: string;
  tenantId: string;
  role?: string | undefined;
  email?: string | undefined;
}

export interface MagicLinkConfirmation {
  token: string;
  tenantId: string;
  email: string;
  role: string;
}

export interface MagicLinkServiceDeps {
  tokens: MagicLinkTokenRepository;
  seats: TeamSeatsRepository;
  resolver: IdentityTenantResolver;
  mailer: Mailer | undefined;
  appUrl: string;
  ttlMinutes: number;
  mintSession: (claims: MagicLinkSessionClaims) => Promise<string>;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function subjectFor(email: string): string {
  return `email:${email}`;
}

/**
 * Passwordless browser sign-in for a verified mailbox.
 *
 * The seat remains the source of truth (ADR-0107): a link is sent only to an
 * address that already has an ACTIVE, VERIFIED seat, and the tenant/role come
 * from IdentityTenantResolver, never from the email itself. Tokens are
 * single-use, short-lived and stored only as hashes; the resulting session
 * is the same httpOnly JWT the SSO flow uses.
 *
 * API keys are not touched: they remain the credential for the CLI and for
 * automation.
 */
export class MagicLinkService {
  constructor(private readonly deps: MagicLinkServiceDeps) {}

  get enabled(): boolean {
    return this.deps.mailer?.configured === true;
  }

  /** Returns silently for an unknown or unverified address (no enumeration). */
  async request(emailInput: string): Promise<void> {
    if (!this.enabled || !this.deps.mailer) return;

    const email = emailInput.trim().toLowerCase();
    const sub = subjectFor(email);
    const [bySubject] = await this.deps.seats.findActiveByUserId(sub);
    const seats =
      bySubject !== undefined
        ? [bySubject]
        : await this.deps.seats.findActiveVerifiedByEmail(email);
    // More than one verified seat for the same address is ambiguous: the
    // resolver refuses to guess, so no link is sent.
    if (seats.length !== 1) return;
    const seat = seats[0]!;

    const raw = randomBytes(32).toString('base64url');
    const record = await this.deps.tokens.create({
      tenantId: seat.tenantId,
      email,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + this.deps.ttlMinutes * 60_000).toISOString(),
    });

    const link = `${this.deps.appUrl.replace(/\/$/, '')}/magic-link?token=${encodeURIComponent(raw)}`;
    try {
      await this.deps.mailer.send({
        to: email,
        subject: 'Sign in to DOMINUS',
        text:
          `Use this link to sign in to DOMINUS:\n\n${link}\n\n` +
          `The link expires in ${this.deps.ttlMinutes} minutes and works once. ` +
          'If you did not ask for it, ignore this email.\n',
      });
    } catch (error) {
      // An undeliverable link must not linger as a usable credential.
      await this.deps.tokens.deleteById(record.id);
      throw error;
    }
  }

  /** Returns undefined for every invalid token (expired, reused, unknown). */
  async confirm(tokenInput: string): Promise<MagicLinkConfirmation | undefined> {
    if (!this.enabled) return undefined;
    if (tokenInput.length < 16 || tokenInput.length > 256) return undefined;

    const record = await this.deps.tokens.findByTokenHash(hashToken(tokenInput));
    if (
      record === undefined ||
      record.consumedAt !== null ||
      Date.parse(record.expiresAt) <= Date.now()
    ) {
      return undefined;
    }

    const sub = subjectFor(record.email);
    const resolved = await this.deps.resolver.resolve({ sub, email: record.email });
    if (resolved.tenantId === undefined) return undefined;

    // Consume before minting: a concurrent second click loses the race.
    if (!(await this.deps.tokens.consume(record.id))) return undefined;

    const session = await this.deps.mintSession({
      sub,
      tenantId: resolved.tenantId,
      ...(resolved.role !== undefined ? { role: resolved.role } : {}),
      email: record.email,
    });

    return {
      token: session,
      tenantId: resolved.tenantId,
      email: record.email,
      role: resolved.role ?? 'member',
    };
  }
}
