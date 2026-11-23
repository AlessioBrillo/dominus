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
import { getContractService } from '../../services/contract-service.js';

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
  // The acceptance is recorded server-side by this route: a separate public
  // "I accept" endpoint would let a caller choose whose acceptance it was.
  contractAcceptance: z
    .object({
      documentVersion: z.string().min(1).max(64),
      documentHashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
      termsAccepted: z.boolean(),
      privacyAccepted: z.boolean(),
      ageConfirmed: z.boolean(),
    })
    .optional(),
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
  recoveryEnabled = true,
  signupEnabled = true,
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
        // A Cloud deployment that is not on sale does not create workspaces:
        // a tenant is a service commitment (privacy notice, support, backups,
        // invoices), not a mailing-list entry. The waitlist lives outside the
        // tenant table, and the landing page points at it.
        if (!signupEnabled) {
          res.status(503).json({
            error: {
              code: 'SIGNUP_CLOSED',
              message:
                'DOMINUS Cloud is not open for paid subscriptions yet. Join the waitlist from the landing page.',
            },
          });
          return;
        }

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

        // The checkbox in the SPA is not evidence. When the ledger is
        // configured (Cloud deployments and the local gate), signup without
        // a matching acceptance of the current text is refused.
        const contractService = getContractService();
        const acceptance = parsed.data.contractAcceptance;
        if (contractService && !acceptance) {
          res.status(428).json({
            error: {
              code: 'CONTRACT_ACCEPTANCE_REQUIRED',
              message: 'Accept the Terms of Service and the Privacy Notice before continuing',
            },
          });
          return;
        }

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

        if (contractService && acceptance) {
          try {
            await contractService.recordSignup({
              subject: email,
              tenantId,
              ref: {
                version: acceptance.documentVersion,
                documentHashes: acceptance.documentHashes,
              },
              termsAccepted: acceptance.termsAccepted,
              privacyAccepted: acceptance.privacyAccepted,
              ageConfirmed: acceptance.ageConfirmed,
            });
          } catch {
            res.status(428).json({
              error: {
                code: 'CONTRACT_ACCEPTANCE_REQUIRED',
                message: 'Accept the current version of the Terms of Service before continuing',
              },
            });
            return;
          }
        }

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
    //
    // AUTH_RECOVERY_ENABLED=false removes the two recovery endpoints: an
    // operator who prefers to hand keys out through support (or who has no
    // mail transport) should not advertise a path that cannot work.
    if (recoveryEnabled) {
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
