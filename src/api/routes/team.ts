// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  DuplicateSeatError,
  SeatNotFoundError,
  TeamSeatLimitError,
} from '../../services/team-service.js';
import type { TeamService } from '../../services/team-service.js';
import type { Config } from '../../config.js';
import { requireRole } from '../middleware/require-role.js';

const emailInviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(['admin', 'member']).default('member'),
});

/** Legacy: reserve a seat for an existing user id. Prefer an email invitation. */
const userInviteSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['admin', 'member']).default('member'),
});

const roleSchema = z.object({
  role: z.enum(['admin', 'member']),
});

/** Seat errors are plain Errors, not DominusErrors, so the global handler would answer 500. */
function sendSeatError(err: unknown, res: Response): boolean {
  if (err instanceof TeamSeatLimitError) {
    res.status(403).json({ error: { code: 'SEAT_LIMIT_EXCEEDED', message: err.message } });
    return true;
  }
  if (err instanceof DuplicateSeatError) {
    res.status(409).json({ error: { code: 'DUPLICATE_SEAT', message: err.message } });
    return true;
  }
  if (err instanceof SeatNotFoundError) {
    res.status(404).json({ error: { code: 'SEAT_NOT_FOUND', message: err.message } });
    return true;
  }
  return false;
}

function validationError(res: Response, message: string, issues: unknown): void {
  res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, issues } });
}

export function createTeamRouter(_config: Config, teamService: TeamService): Router {
  const router = Router();

  const fail = (err: unknown, res: Response, next: NextFunction): void => {
    if (!sendSeatError(err, res)) next(err);
  };

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await teamService.getTeamSummary(req.tenantId ?? 'default'));
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/invite',
    requireRole('admin'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = req.tenantId ?? 'default';
        const invitedBy = req.auth?.userId ?? req.auth?.keyName ?? 'system';

        // Email invitation: single-use link, emailed when SMTP is configured.
        if (typeof (req.body as { email?: unknown } | undefined)?.email === 'string') {
          const parsed = emailInviteSchema.safeParse(req.body);
          if (!parsed.success) {
            validationError(res, 'Invalid invite request', parsed.error.issues);
            return;
          }
          const created = await teamService.createInvitation(
            tenantId,
            parsed.data.email,
            parsed.data.role,
            invitedBy,
          );
          res.status(201).json({
            invitation: {
              id: created.invitation.id,
              email: created.invitation.email,
              role: created.invitation.role,
              expiresAt: created.invitation.expiresAt,
            },
            link: created.link,
            emailed: created.emailed,
          });
          return;
        }

        const parsed = userInviteSchema.safeParse(req.body);
        if (!parsed.success) {
          validationError(res, 'Invalid invite request', parsed.error.issues);
          return;
        }
        await teamService.inviteMember(tenantId, parsed.data.userId, parsed.data.role, invitedBy);
        res.status(201).json({ status: 'invited' });
      } catch (err) {
        fail(err, res, next);
      }
    },
  );

  router.delete(
    '/invitations/:id',
    requireRole('admin'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = Number.parseInt(req.params.id as string, 10);
        if (!Number.isInteger(id) || id < 1) {
          res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid invitation id' } });
          return;
        }
        const removed = await teamService.revokeInvitation(req.tenantId ?? 'default', id);
        if (!removed) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } });
          return;
        }
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const userId = req.auth?.userId ?? 'unknown';
      await teamService.acceptInvite(tenantId, userId);
      res.json({ status: 'active' });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.patch(
    '/:userId/role',
    requireRole('admin'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = roleSchema.safeParse(req.body);
        if (!parsed.success) {
          validationError(res, 'Invalid role update', parsed.error.issues);
          return;
        }
        await teamService.updateMemberRole(
          req.tenantId ?? 'default',
          req.params.userId as string,
          parsed.data.role,
        );
        res.json({ status: 'updated' });
      } catch (err) {
        fail(err, res, next);
      }
    },
  );

  router.delete(
    '/:userId',
    requireRole('admin'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await teamService.removeMember(req.tenantId ?? 'default', req.params.userId as string);
        res.json({ status: 'removed' });
      } catch (err) {
        fail(err, res, next);
      }
    },
  );

  return router;
}
