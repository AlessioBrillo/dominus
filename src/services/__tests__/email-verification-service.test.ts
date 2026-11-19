// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { TeamSeatsRepository } from '../../db/repositories/team-seats-repository.js';
import { SignupVerificationRepository } from '../../db/repositories/signup-verification-repository.js';
import { SubscriptionRepository } from '../../db/repositories/subscription-repository.js';
import {
  EmailVerificationService,
  VerificationInvalidError,
} from '../email-verification-service.js';
import type { Mailer, MailMessage } from '../../providers/email/mailer.js';
import type { GeneratedKeyResult, KeyManager } from '../../providers/auth/auth-provider.js';

class RecordingMailer implements Mailer {
  readonly configured = true;
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

function makeKeyManager(): KeyManager & { revoked: string[] } {
  const revoked: string[] = [];
  let counter = 0;
  return {
    revoked,
    name: 'DbApiKeyProvider',
    isActive: true,
    supportsKeyManagement: true,
    asKeyManager: () => undefined as never,
    validate: async () => ({ authenticated: false }),
    generate: async ({
      name,
    }: {
      tenantId: string;
      name: string;
      role?: string;
    }): Promise<GeneratedKeyResult> => {
      counter += 1;
      return { id: counter, fullKey: `key-${counter}`, prefix: `key-${counter}`, name };
    },
    revokeAll: async (tenantId: string): Promise<number> => {
      revoked.push(tenantId);
      return 1;
    },
  } as unknown as KeyManager & { revoked: string[] };
}

describe('EmailVerificationService', () => {
  let db: SqliteProvider;
  let seats: TeamSeatsRepository;
  let verifications: SignupVerificationRepository;
  let subs: SubscriptionRepository;
  let mailer: RecordingMailer;
  let keyManager: ReturnType<typeof makeKeyManager>;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    seats = new TeamSeatsRepository(db);
    verifications = new SignupVerificationRepository(db);
    subs = new SubscriptionRepository(db);
    mailer = new RecordingMailer();
    keyManager = makeKeyManager();
  });

  afterEach(async () => {
    await db.close();
  });

  function service(): EmailVerificationService {
    return new EmailVerificationService({
      verifications,
      seats,
      keyManager,
      mailer,
      appUrl: 'https://app.example.com',
    });
  }

  async function pendingSignup(email: string): Promise<string> {
    const tenantId = `tenant-${email}`;
    await subs.ensureDefault(tenantId);
    await seats.invite(tenantId, email, 'admin', email);
    return tenantId;
  }

  it('activates the workspace and issues the key when the link is opened', async () => {
    const tenantId = await pendingSignup('owner@example.com');
    const svc = service();

    const issued = await svc.issueSignupVerification({
      tenantId,
      email: 'owner@example.com',
      name: 'Alessio',
    });
    expect(mailer.sent).toHaveLength(1);
    expect(String(mailer.sent[0]?.text)).toContain('https://app.example.com/verify-email?token=');

    const verified = await svc.verifySignup(issued.token);

    expect(verified.tenantId).toBe(tenantId);
    expect(verified.key.fullKey).toBe('key-1');
    const seat = await seats.findByTenantAndUser(tenantId, 'owner@example.com');
    expect(seat?.status).toBe('active');
    expect(seat?.emailVerifiedAt).not.toBeNull();
  });

  it('revokes the keys issued before the proof', async () => {
    const tenantId = await pendingSignup('owner@example.com');
    const svc = service();

    const issued = await svc.issueSignupVerification({
      tenantId,
      email: 'owner@example.com',
      name: 'Alessio',
    });
    await svc.verifySignup(issued.token);

    // The key of whoever created the workspace must not survive the proof
    // that the mailbox belongs to somebody else.
    expect(keyManager.revoked).toEqual([tenantId]);
  });

  it('accepts a token only once', async () => {
    const tenantId = await pendingSignup('owner@example.com');
    const svc = service();
    const issued = await svc.issueSignupVerification({
      tenantId,
      email: 'owner@example.com',
      name: 'Alessio',
    });

    await svc.verifySignup(issued.token);
    await expect(svc.verifySignup(issued.token)).rejects.toBeInstanceOf(VerificationInvalidError);
  });

  it('refuses an unknown token', async () => {
    const svc = service();
    await expect(svc.verifySignup('not-a-real-token')).rejects.toBeInstanceOf(
      VerificationInvalidError,
    );
  });

  it('refuses an expired token', async () => {
    const tenantId = await pendingSignup('owner@example.com');
    const svc = new EmailVerificationService({
      verifications,
      seats,
      keyManager,
      mailer,
      appUrl: 'https://app.example.com',
      signupTtlHours: 0,
    });
    const issued = await svc.issueSignupVerification({
      tenantId,
      email: 'owner@example.com',
      name: 'Alessio',
    });
    await expect(svc.verifySignup(issued.token)).rejects.toBeInstanceOf(VerificationInvalidError);
  });

  it('recovers a key for a verified address', async () => {
    const tenantId = await pendingSignup('owner@example.com');
    const svc = service();
    const issued = await svc.issueSignupVerification({
      tenantId,
      email: 'owner@example.com',
      name: 'Alessio',
    });
    await svc.verifySignup(issued.token);

    expect(await svc.requestRecovery('owner@example.com')).toBe(true);
    expect(mailer.sent).toHaveLength(2);
    expect(String(mailer.sent[1]?.text)).toContain('https://app.example.com/recover?token=');

    const token = /recover\?token=([A-Za-z0-9_-]+)/.exec(String(mailer.sent[1]?.text))?.[1];
    expect(token).toBeDefined();
    const recovered = await svc.confirmRecovery(token as string);
    expect(recovered.tenantId).toBe(tenantId);
  });

  it('does not recover an address that was never verified', async () => {
    await pendingSignup('owner@example.com');
    const svc = service();
    expect(await svc.requestRecovery('owner@example.com')).toBe(false);
  });

  it('stores only the hash of the token', async () => {
    const tenantId = await pendingSignup('owner@example.com');
    const svc = service();
    const issued = await svc.issueSignupVerification({
      tenantId,
      email: 'owner@example.com',
      name: 'Alessio',
    });

    const stored = await verifications.findByTokenHash(
      // The repository stores the SHA-256 of the token.
      (await import('node:crypto')).createHash('sha256').update(issued.token).digest('hex'),
    );
    expect(stored).toBeDefined();
    const raw = await db.queryOne<{ token_hash: string }>(
      'SELECT token_hash FROM signup_verifications',
    );
    expect(raw?.token_hash).not.toContain(issued.token);
  });
});
