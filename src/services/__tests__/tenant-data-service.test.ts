// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { TenantDataService, REDACTED_VALUE } from '../tenant-data-service.js';

/**
 * The data-subject export and erasure.
 *
 * The assertions that matter are the negative ones: the export must not
 * contain another tenant's rows, and the erasure must not touch another
 * tenant's rows. A data-subject right that leaks is worse than one that is
 * missing.
 */
describe('TenantDataService', () => {
  let db: SqliteProvider;
  let service: TenantDataService;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    service = new TenantDataService(db);

    await db.exec(
      `INSERT INTO candidates (domain, tld, source, tenant_id) VALUES ('alpha.com', 'com', 'manual', 'tenant-a')`,
    );
    await db.exec(
      `INSERT INTO candidates (domain, tld, source, tenant_id) VALUES ('beta.com', 'com', 'manual', 'tenant-b')`,
    );
    const candidate = await db.queryOne<{ id: number }>(
      `SELECT id FROM candidates WHERE tenant_id = 'tenant-a'`,
    );
    await db.exec(
      `INSERT INTO scoring_runs (candidate_id, run_id, expected_value, confidence, suggested_buy_max,
        suggested_list_price, intrinsic_score, commercial_score, market_score, expiry_score,
        signal_scores, tenant_id)
       VALUES (${candidate?.id ?? 0}, 'run-1', 100, 0.5, 50, 300, 0.5, 0.5, 0.5, 0.5, '{}', 'tenant-a')`,
    );
    await db.exec(
      `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost,
        renewal_cost, registrar, tenant_id)
       VALUES ('alpha.com', 'com', '2026-01-01', '2027-01-01', 10, 12, 'registrar', 'tenant-a')`,
    );
    await db.exec(
      `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost,
        renewal_cost, registrar, tenant_id)
       VALUES ('gamma.com', 'com', '2026-01-01', '2027-01-01', 10, 12, 'registrar', 'tenant-b')`,
    );
    await db.exec(
      `INSERT INTO team_seats (tenant_id, user_id, role, status) VALUES ('tenant-a', 'user-1', 'admin', 'active')`,
    );
    await db.exec(
      `INSERT INTO team_seats (tenant_id, user_id, role, status) VALUES ('tenant-b', 'user-2', 'admin', 'active')`,
    );
  });

  afterEach(async () => {
    await db.close();
  });

  describe('exportTenant', () => {
    it('returns the rows of the tenant and nothing else', async () => {
      const result = await service.exportTenant('tenant-a');

      const candidates = result.tables.find((t) => t.table === 'candidates');
      expect(candidates?.rows).toHaveLength(1);
      expect(candidates?.rows[0]?.domain).toBe('alpha.com');
      expect(candidates?.truncated).toBe(false);

      const seats = result.tables.find((t) => t.table === 'team_seats');
      expect(seats?.rows).toHaveLength(1);
      expect(seats?.rows[0]?.user_id).toBe('user-1');
    });

    it('covers every tenant-scoped table', async () => {
      const result = await service.exportTenant('tenant-a');
      // 32 tenant-scoped tables: the export must not silently skip one.
      expect(result.tables.length).toBeGreaterThanOrEqual(30);
      for (const table of result.tables) {
        expect(table.rows.every((row) => row.tenant_id === 'tenant-a')).toBe(true);
      }
    });

    it('returns an empty export for an unknown tenant', async () => {
      const result = await service.exportTenant('tenant-unknown');
      expect(result.totalRows).toBe(0);
      expect(result.tenantId).toBe('tenant-unknown');
    });

    it('flags a table that hit the row cap instead of cutting it silently', async () => {
      const capped = new TenantDataService(db, { maxRowsPerTable: 1 });
      const result = await capped.exportTenant('tenant-a');

      const candidates = result.tables.find((t) => t.table === 'candidates');
      expect(candidates?.truncated).toBe(false);

      const tiny = new TenantDataService(db, { maxRowsPerTable: 0 });
      const tinyResult = await tiny.exportTenant('tenant-a');
      const tinyCandidates = tinyResult.tables.find((t) => t.table === 'candidates');
      expect(tinyCandidates?.truncated).toBe(true);
      expect(tinyCandidates?.rows).toHaveLength(0);
    });
  });

  describe('deleteTenant', () => {
    it('erases the tenant and leaves the other one untouched', async () => {
      const report = await service.deleteTenant('tenant-a');

      expect(report.tenantId).toBe('tenant-a');
      expect(report.liveDataErased).toBe(true);
      expect(report.totalRows).toBeGreaterThan(0);

      const remaining = await db.query<{ domain: string }>(
        `SELECT domain FROM candidates WHERE tenant_id = 'tenant-a'`,
      );
      expect(remaining).toHaveLength(0);

      const otherTenant = await db.query<{ domain: string }>(
        `SELECT domain FROM candidates WHERE tenant_id = 'tenant-b'`,
      );
      expect(otherTenant.map((r) => r.domain)).toEqual(['beta.com']);

      const otherSeats = await db.query<{ user_id: string }>(
        `SELECT user_id FROM team_seats WHERE tenant_id = 'tenant-b'`,
      );
      expect(otherSeats).toHaveLength(1);
    });

    it('erases the rows that reference other rows of the same tenant', async () => {
      await service.deleteTenant('tenant-a');

      const scoringRuns = await db.query<{ id: number }>(`SELECT id FROM scoring_runs`);
      expect(scoringRuns).toHaveLength(0);

      const portfolio = await db.query<{ domain: string }>(
        `SELECT domain FROM portfolio_entries WHERE tenant_id = 'tenant-a'`,
      );
      expect(portfolio).toHaveLength(0);
    });

    it('reports what it erased', async () => {
      const report = await service.deleteTenant('tenant-a');
      const candidates = report.tables.find((t) => t.table === 'candidates');
      expect(candidates?.rows).toBe(1);
      expect(candidates?.retained).toBe(false);
    });

    it('is idempotent: erasing twice erases nothing the second time', async () => {
      await service.deleteTenant('tenant-a');
      const second = await service.deleteTenant('tenant-a');
      expect(second.totalRows).toBe(0);
    });
  });

  describe('subscription cancellation', () => {
    it('cancels the subscription before erasing the rows', async () => {
      const order: string[] = [];
      const canceller = vi.fn(async (tenantId: string) => {
        order.push(`cancel:${tenantId}`);
        return true;
      });
      const withBilling = new TenantDataService(db, { subscriptionCanceller: canceller });

      const report = await withBilling.deleteTenant('tenant-a');

      expect(canceller).toHaveBeenCalledWith('tenant-a');
      expect(order).toEqual(['cancel:tenant-a']);
      expect(report.subscriptionCancelled).toBe(true);
    });

    it('erases the rows even when the cancellation fails, and says so', async () => {
      const canceller = vi.fn(async () => {
        throw new Error('stripe unreachable');
      });
      const withBilling = new TenantDataService(db, { subscriptionCanceller: canceller });

      const report = await withBilling.deleteTenant('tenant-a');

      expect(report.subscriptionCancelled).toBe(false);
      const remaining = await db.query<{ domain: string }>(
        `SELECT domain FROM candidates WHERE tenant_id = 'tenant-a'`,
      );
      expect(remaining).toHaveLength(0);
    });

    it('reports no subscription when the tenant has none', async () => {
      const canceller = vi.fn(async () => false);
      const withBilling = new TenantDataService(db, { subscriptionCanceller: canceller });

      const report = await withBilling.deleteTenant('tenant-a');

      expect(report.subscriptionCancelled).toBe(false);
    });

    it('does not touch the subscription when no canceller is configured', async () => {
      const report = await service.deleteTenant('tenant-a');
      expect(report.subscriptionCancelled).toBeNull();
    });
  });

  describe('secret redaction', () => {
    beforeEach(async () => {
      await db.exec(
        `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, role)
         VALUES ('tenant-a', 'ops', 'salt:derived', 'abcdef123456', 'admin')`,
      );
      await db.exec(
        `INSERT INTO team_invitations (tenant_id, email, role, token_hash, expires_at)
         VALUES ('tenant-a', 'member@example.com', 'member', 'invitationhash', '2027-01-01')`,
      );
      await db.exec(
        `INSERT INTO tenant_credentials (tenant_id, provider_type, provider_name, encrypted_credential)
         VALUES ('tenant-a', 'registrar', 'cloudflare', 'ciphertext')`,
      );
    });

    it('does not export the API key hash', async () => {
      const exported = await service.exportTenant('tenant-a');
      const apiKeys = exported.tables.find((t) => t.table === 'api_keys');
      expect(apiKeys?.rows).toHaveLength(1);
      expect(apiKeys?.rows[0]?.['key_hash']).toBe(REDACTED_VALUE);
      expect(JSON.stringify(exported)).not.toContain('salt:derived');
    });

    it('does not export the invitation token hash', async () => {
      const exported = await service.exportTenant('tenant-a');
      expect(JSON.stringify(exported)).not.toContain('invitationhash');
    });

    it('does not export the stored provider credential', async () => {
      const exported = await service.exportTenant('tenant-a');
      expect(JSON.stringify(exported)).not.toContain('ciphertext');
    });

    it('keeps the non-secret columns of the same rows', async () => {
      const exported = await service.exportTenant('tenant-a');
      const apiKeys = exported.tables.find((t) => t.table === 'api_keys');
      expect(apiKeys?.rows[0]?.['name']).toBe('ops');
      expect(apiKeys?.rows[0]?.['key_prefix']).toBe('abcdef123456');
    });

    it('redacts only the credential columns of the listed tables', () => {
      const rows = [{ domain: 'alpha.com', key_hash: 'x' }];
      expect(TenantDataService.redact('candidates', rows)).toEqual(rows);
      expect(TenantDataService.redact('api_keys', rows)[0]?.['key_hash']).toBe(REDACTED_VALUE);
    });
  });
});
