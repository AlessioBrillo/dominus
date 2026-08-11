// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { TeamService } from '../../services/team-service.js';
import type { Config } from '../../config.js';

const inviteSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['admin', 'member']).default('member'),
});

const roleSchema = z.object({
  role: z.enum(['admin', 'member']),
});

export function createTeamRouter(_config: Config, teamService: TeamService): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const summary = await teamService.getTeamSummary(tenantId);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  router.post('/invite', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid invite request',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      await teamService.inviteMember(
        tenantId,
        parsed.data.userId,
        parsed.data.role,
        req.auth?.userId ?? 'system',
      );
      res.status(201).json({ status: 'invited' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const userId = req.auth?.userId ?? 'unknown';
      await teamService.acceptInvite(tenantId, userId);
      res.json({ status: 'active' });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:userId/role', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const parsed = roleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid role update',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      await teamService.updateMemberRole(tenantId, req.params.userId as string, parsed.data.role);
      res.json({ status: 'updated' });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:userId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      await teamService.removeMember(tenantId, req.params.userId as string);
      res.json({ status: 'removed' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
