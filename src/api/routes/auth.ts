// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';
import type { TenantProvisioningService } from '../../services/tenant-provisioning-service.js';
import {
  VerificationDeliveryError,
  VerificationInvalidError,
} from '../../services/email-verification-service.js';
import type { EmailVerificationService } from '../../services/email-verification-service.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface LoginRequest {
  apiKey: string;
}

export interface LoginResponse {
  authenticated: boolean;
  token?: string;
  identity?: string;
  error?: string;
}

const registerSchema = z.object({
  name: z.string().min(1).max(80),
  // The address identifies the owner of the workspace. It is required: a
  // workspace whose owner cannot be reached cannot be verified, recovered
  // or claimed through single sign-on.
  email: z.string().email().max(254),
});

const tokenSchema = z.object({
  token: z.string().min(16).max(256),
});

const emailSchema = z.object({
  email: z.string().email().max(254),
});

/**
 * How the self-serve signup treats the email address.
 *
 * - `required`: no API key is issued before the address is proven. The
 *   workspace is inert until the link is opened. This is the only mode a
 *   public deployment may use.
 * - `optional`: the key is issued immediately and the address is verified
 *   later. The seat stays UNVERIFIED until then, so it can never be claimed
 *   through single sign-on — the takeover stays closed either way. It exists
 *   for the deployments with no mail transport (a private beta, the
 *   acceptance stack), where the alternative is no self-serve signup at all.
 */
export type SignupVerificationMode = 'required' | 'optional';

export interface AuthRouterDeps {
  authProvider: AuthProvider;
  provisioningService?: TenantProvisioningService;
  verificationService?: EmailVerificationService;
  signupVerificationMode?: SignupVerificationMode;
}

export function createAuthRouter(
  authProvider: AuthProvider,
  provisioningService?: TenantProvisioningService,
  verificationService?: EmailVerificationService,
  signupVerificationMode: SignupVerificationMode = 'required',
): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const { apiKey } = req.body as LoginRequest;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      res.status(400).json({
        authenticated: false,
        error: 'API key is required',
      } satisfies LoginResponse);
      return;
    }

    const result = await authProvider.validate(apiKey.trim());

    if (!result.authenticated) {
      res.status(403).json({
        authenticated: false,
        error: 'Invalid API key',
      } satisfies LoginResponse);
      return;
    }

    res.json({
      authenticated: true,
      token: apiKey.trim(),
      identity: result.keyName ?? 'default',
    } satisfies LoginResponse);
  });

  if (provisioningService) {
    router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = registerSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid registration request',
              issues: parsed.error.issues,
            },
          });
          return;
        }

        const email = parsed.data.email.trim().toLowerCase();

        // Fail closed BEFORE anything is written: a workspace whose
        // verification link can never be delivered is a workspace nobody can
        // use, and the rows would sit there forever.
        if (signupVerificationMode === 'required' && !verificationService?.canDeliver) {
          res.status(503).json({
            error: {
              code: 'EMAIL_NOT_CONFIGURED',
              message:
                'Signup is unavailable: the verification email cannot be delivered (set SMTP_URL)',
            },
          });
          return;
        }

        const { tenantId } = await provisioningService.provisionTenant({
          name: parsed.data.name,
          email,
        });

        if (signupVerificationMode === 'optional') {
          // The key is issued right away, but the seat is NOT verified: it
          // cannot be claimed through single sign-on until the owner proves
          // the address.
          const apiKey = await provisioningService.activateOwner({
            tenantId,
            email,
            name: parsed.data.name,
          });
          await sendVerificationBestEffort(verificationService, {
            tenantId,
            email,
            name: parsed.data.name,
          });
          res.status(201).json({
            tenantId,
            key: apiKey.fullKey,
            prefix: apiKey.prefix,
            verificationRequired: false,
            message: 'Save this key — it will not be shown again.',
          });
          return;
        }

        await verificationService?.issueSignupVerification({
          tenantId,
          email,
          name: parsed.data.name,
        });

        res.status(201).json({
          tenantId,
          verificationRequired: true,
          message: 'Check your inbox: the workspace is activated by the verification link.',
        });
      } catch (err) {
        if (err instanceof VerificationDeliveryError) {
          logger.error({ err: err.message }, 'The signup verification email could not be sent');
          res.status(503).json({
            error: { code: 'EMAIL_DELIVERY_FAILED', message: err.message },
          });
          return;
        }
        next(err);
      }
    });
  }

  if (verificationService) {
    // Redeem the signup token: the workspace becomes usable and the keys
    // issued before the proof are revoked.
    router.post('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = tokenSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'A verification token is required' },
          });
          return;
        }
        const verified = await verificationService.verifySignup(parsed.data.token);
        res.json({
          tenantId: verified.tenantId,
          key: verified.key.fullKey,
          prefix: verified.key.prefix,
          message: 'Save this key — it will not be shown again.',
        });
      } catch (err) {
        if (err instanceof VerificationInvalidError) {
          res.status(400).json({ error: { code: err.code, message: err.message } });
          return;
        }
        next(err);
      }
    });

    // Ask for a new signup link. The answer is the same whether the address
    // exists or not: the endpoint must not be an account oracle.
    router.post('/resend-verification', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = emailSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'A valid email is required' },
          });
          return;
        }
        const email = parsed.data.email.trim().toLowerCase();
        await verificationService.resendSignupVerification(email).catch((err: unknown) => {
          // The answer stays the same (the endpoint is not an oracle), but a
          // delivery that could not happen is worth a log line.
          logger.warn({ err, email }, 'The verification email could not be sent');
        });
        res.status(202).json({ sent: true });
      } catch (err) {
        next(err);
      }
    });

    // Ask for a recovery link. Same rule: the answer never says whether the
    // address has an account.
    router.post('/recover', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = emailSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'A valid email is required' },
          });
          return;
        }
        const email = parsed.data.email.trim().toLowerCase();
        await verificationService.requestRecovery(email).catch((err: unknown) => {
          logger.warn({ err }, 'The recovery email could not be sent');
        });
        res.status(202).json({ sent: true });
      } catch (err) {
        next(err);
      }
    });

    // Redeem a recovery token and receive a fresh key.
    router.post('/recover/confirm', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = tokenSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'A recovery token is required' },
          });
          return;
        }
        const recovered = await verificationService.confirmRecovery(parsed.data.token);
        res.json({
          tenantId: recovered.tenantId,
          key: recovered.key.fullKey,
          prefix: recovered.key.prefix,
          message: 'Save this key — it will not be shown again.',
        });
      } catch (err) {
        if (err instanceof VerificationInvalidError) {
          res.status(400).json({ error: { code: err.code, message: err.message } });
          return;
        }
        next(err);
      }
    });
  }

  return router;
}

/**
 * Send the verification email without failing the request.
 *
 * Used by the deployments that run without a mail transport: the workspace
 * works, the address is simply not proven yet, and the seat cannot be
 * claimed through single sign-on until it is.
 */
async function sendVerificationBestEffort(
  verificationService: EmailVerificationService | undefined,
  input: { tenantId: string; email: string; name: string },
): Promise<void> {
  if (!verificationService?.canDeliver) return;
  try {
    await verificationService.issueSignupVerification(input);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), tenantId: input.tenantId },
      'The signup verification email could not be sent',
    );
  }
}
