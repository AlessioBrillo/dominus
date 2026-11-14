// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { TenantNotificationService } from '../../services/tenant-notification-service.js';
import { TenantNotificationSettingsError } from '../../services/tenant-notification-service.js';
import { requireRole } from '../middleware/require-role.js';
import { validate } from '../middleware/validate.js';
import { AlertSeverity, AlertType } from '../../types/alert.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const settingsSchema = z.object({
  email: z.string().email().max(254).nullable().optional(),
  webhookUrl: z.string().url().max(2000).nullable().optional(),
  telegramChatId: z.string().min(1).max(100).nullable().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Where the tenant wants to be told about its own domains.
 *
 * The operator's channels (the webhook, the Telegram chat, the mailbox of
 * the person who runs the installation) are not the customer's channels: a
 * renewal alert about a customer's domain must reach the customer, and it
 * must not reach the operator.
 */
export function createTenantNotificationsRouter(service: TenantNotificationService): Router {
  const router = Router();
  router.use(requireRole('admin'));

  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = req.tenantId ?? 'default';
      res.json(await service.get(tenantId));
    } catch (err) {
      next(err);
    }
  });

  router.put(
    '/',
    validate({ body: settingsSchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const tenantId = req.tenantId ?? 'default';
        const body = req.body as z.infer<typeof settingsSchema>;
        const settings = await service.save(tenantId, body);
        res.json(settings);
      } catch (err) {
        if (err instanceof TenantNotificationSettingsError) {
          res.status(400).json({ error: { code: err.code, message: err.message } });
          return;
        }
        next(err);
      }
    },
  );

  router.delete('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const deleted = await service.clear(tenantId);
      res.json({ deleted });
    } catch (err) {
      next(err);
    }
  });

  // Send a test alert to the channels of the tenant: the only way to know
  // that a webhook or a chat id works before the first renewal.
  router.post('/test', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const channels = await service.sendToTenant(tenantId, {
        domain: 'example.com',
        alertType: AlertType.SystemError,
        severity: AlertSeverity.Info,
        message: 'DOMINUS test notification — your channels are working.',
        details: `Tenant: ${tenantId}`,
        createdAt: new Date().toISOString(),
      } as never);
      if (channels.length === 0) {
        res.status(409).json({
          error: {
            code: 'NO_NOTIFICATION_CHANNEL',
            message: 'No channel is configured (or none could be delivered to)',
          },
        });
        return;
      }
      res.json({ channels });
    } catch (err) {
      logger.warn({ err }, 'The test notification failed');
      next(err);
    }
  });

  return router;
}
