// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createTeamRouter } from '../team.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { TeamService } from '../../../services/team-service.js';
import type { TeamSummary } from '../../../services/team-service.js';
import { TeamSeatLimitError } from '../../../services/team-service.js';

function makeStubService(): TeamService {
  return {
    getTeamSummary: vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      plan: 'team',
      seatLimit: 10,
      activeSeats: 2,
      pendingSeats: 1,
      members: [
        {
          userId: 'user-1',
          role: 'admin',
          status: 'active',
          invitedAt: '2026-08-01T00:00:00Z',
          joinedAt: '2026-08-01T00:00:00Z',
        },
        {
          userId: 'user-2',
          role: 'member',
          status: 'pending',
          invitedAt: '2026-08-02T00:00:00Z',
          joinedAt: null,
        },
      ],
    } as TeamSummary),
    inviteMember: vi.fn().mockResolvedValue(undefined),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    updateMemberRole: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
    canAddSeat: vi.fn().mockResolvedValue(true),
  } as unknown as TeamService;
}

function buildApp(service?: TeamService, role = 'admin'): Application {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = 'tenant-1';
    req.auth = { role, tenantId: 'tenant-1', userId: 'owner-1' };
    next();
  });

  app.use('/api/v1/team', createTeamRouter({} as never, service ?? makeStubService()));
  app.use(errorHandler);
  return app;
}

describe('API: /api/v1/team', () => {
  describe('GET /', () => {
    it('returns team summary', async () => {
      const app = buildApp();
      const res = await request(app).get('/api/v1/team');

      expect(res.status).toBe(200);
      expect(res.body.plan).toBe('team');
      expect(res.body.seatLimit).toBe(10);
      expect(res.body.activeSeats).toBe(2);
      expect(res.body.members).toHaveLength(2);
    });
  });

  describe('POST /invite', () => {
    it('invites a member and returns 201', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/team/invite')
        .send({ userId: 'user-3', role: 'member' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('invited');
    });

    it('defaults role to member', async () => {
      const service = makeStubService();
      const app = buildApp(service);
      const res = await request(app).post('/api/v1/team/invite').send({ userId: 'user-3' });

      expect(res.status).toBe(201);
      expect(service.inviteMember).toHaveBeenCalledWith('tenant-1', 'user-3', 'member', 'owner-1');
    });

    it('returns 400 for invalid request', async () => {
      const app = buildApp();
      const res = await request(app).post('/api/v1/team/invite').send({ role: 'member' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /accept', () => {
    it('accepts an invite', async () => {
      const app = buildApp();
      const res = await request(app).post('/api/v1/team/accept');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
    });
  });

  describe('PATCH /:userId/role', () => {
    it('updates a member role', async () => {
      const service = makeStubService();
      const app = buildApp(service);
      const res = await request(app).patch('/api/v1/team/user-2/role').send({ role: 'admin' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('updated');
      expect(service.updateMemberRole).toHaveBeenCalledWith('tenant-1', 'user-2', 'admin');
    });

    it('returns 400 for invalid role', async () => {
      const app = buildApp();
      const res = await request(app).patch('/api/v1/team/user-2/role').send({ role: 'owner' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /:userId', () => {
    it('removes a member', async () => {
      const service = makeStubService();
      const app = buildApp(service);
      const res = await request(app).delete('/api/v1/team/user-2');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('removed');
      expect(service.removeMember).toHaveBeenCalledWith('tenant-1', 'user-2');
    });
  });
});

describe('API: /api/v1/team — email invitations', () => {
  const created = {
    invitation: {
      id: 7,
      email: 'new@example.com',
      role: 'member',
      expiresAt: '2026-10-15T00:00:00Z',
    },
    link: 'https://app.example.com/invite/tok',
    emailed: false,
  };

  function stub(overrides: Record<string, unknown> = {}): TeamService {
    return {
      createInvitation: vi.fn().mockResolvedValue(created),
      revokeInvitation: vi.fn().mockResolvedValue(true),
      inviteMember: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as TeamService;
  }

  it('creates an invitation and returns the one-time link', async () => {
    const service = stub();
    const res = await request(buildApp(service))
      .post('/api/v1/team/invite')
      .send({ email: 'New@Example.com', role: 'member' });

    expect(res.status).toBe(201);
    expect(res.body.link).toBe(created.link);
    expect(res.body.emailed).toBe(false);
    expect(res.body.invitation.id).toBe(7);
    expect(service.createInvitation).toHaveBeenCalledWith(
      'tenant-1',
      'New@Example.com',
      'member',
      'owner-1',
    );
    expect(service.inviteMember).not.toHaveBeenCalled();
  });

  it('rejects a malformed email with 400', async () => {
    const res = await request(buildApp(stub())).post('/api/v1/team/invite').send({ email: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses to invite the owner role via the API', async () => {
    const res = await request(buildApp(stub()))
      .post('/api/v1/team/invite')
      .send({ email: 'a@example.com', role: 'owner' });
    expect(res.status).toBe(400);
  });

  it('answers 403 SEAT_LIMIT_EXCEEDED when the plan is full', async () => {
    const service = stub({
      createInvitation: vi.fn().mockRejectedValue(new TeamSeatLimitError(3, 3)),
    });
    const res = await request(buildApp(service))
      .post('/api/v1/team/invite')
      .send({ email: 'a@example.com' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SEAT_LIMIT_EXCEEDED');
  });

  it('revokes an invitation, 404 when it is not found', async () => {
    const ok = await request(buildApp(stub())).delete('/api/v1/team/invitations/7');
    expect(ok.status).toBe(204);

    const missing = await request(
      buildApp(stub({ revokeInvitation: vi.fn().mockResolvedValue(false) })),
    ).delete('/api/v1/team/invitations/9');
    expect(missing.status).toBe(404);

    const bad = await request(buildApp(stub())).delete('/api/v1/team/invitations/abc');
    expect(bad.status).toBe(400);
  });

  it('only admins can invite or revoke', async () => {
    const app = buildApp(stub(), 'member');
    expect(
      (await request(app).post('/api/v1/team/invite').send({ email: 'a@example.com' })).status,
    ).toBe(403);
    expect((await request(app).delete('/api/v1/team/invitations/7')).status).toBe(403);
  });
});
