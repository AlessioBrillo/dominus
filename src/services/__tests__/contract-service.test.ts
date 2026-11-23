// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { ContractAcceptanceRepository } from '../../db/repositories/contract-acceptance-repository.js';
import { ContractService, ContractAcceptanceError } from '../contract-service.js';
import { buildLegalContent } from '../legal-content.js';
import { identityFromConfig, validateIdentity } from '../legal-identity.js';

const VERSION = '2026-11-24';

describe('contract acceptance ledger', () => {
  let provider: SqliteProvider;
  let service: ContractService;

  beforeEach(() => {
    const db = new Database(':memory:');
    provider = new SqliteProvider(db);
    runMigrations(db);
    service = new ContractService(new ContractAcceptanceRepository(provider));
  });

  const legal = (): ReturnType<typeof buildLegalContent> =>
    buildLegalContent({
      identity: identityFromConfig({
        LEGAL_ENTITY_NAME: 'Example Operator SRL',
        LEGAL_ENTITY_KIND: 'company',
        LEGAL_LEGAL_FORM: 'SRL',
        LEGAL_REGISTERED_ADDRESS: 'Via Roma 1, Roma, Italy',
        LEGAL_VAT_ID: 'IT12345678901',
        LEGAL_REA_NUMBER: 'RM-123456',
        LEGAL_REGISTRO_IMPRESE: 'Registro Imprese di Roma',
        LEGAL_PEC: 'operator@pec.it',
        LEGAL_PRIVACY_EMAIL: 'privacy@example.it',
        LEGAL_CONTACT_EMAIL: 'hello@example.it',
      }),
      cloudMode: true,
      paidService: true,
    });

  it('rejects an S.r.l. configured with the forfettario regime', () => {
    expect(
      validateIdentity(
        identityFromConfig({ LEGAL_ENTITY_KIND: 'company', LEGAL_VAT_REGIME: 'forfettario' }),
      ),
    ).toContainEqual(expect.stringContaining('cannot use the Italian forfettario'));
  });

  it('hashes the published documents so an accepted version can be proved', async () => {
    const html = legal();
    expect(html.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(html.version).toBe(VERSION);
  });

  it('records a signup acceptance and finds it again', async () => {
    const { version, contentHash } = legal();
    await service.record({
      email: 'BUYER@Example.com',
      purpose: 'signup',
      documentSlug: 'terms',
      documentVersion: version,
      contentHash,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    await expect(
      service.requireSignup({ email: 'buyer@example.com', version, contentHash }),
    ).resolves.toBeUndefined();
    const rows = await service.listForTenant('tenant-1');
    expect(rows).toEqual([]);
  });

  it('refuses checkout without a matching acceptance', async () => {
    const { version, contentHash } = legal();
    await expect(
      service.requireCheckout({
        tenantId: 'tenant-1',
        version,
        contentHash,
        needsArt1341: false,
      }),
    ).rejects.toBeInstanceOf(ContractAcceptanceError);
  });

  it('refuses a business checkout without the art. 1341 approval', async () => {
    const { version, contentHash } = legal();
    await service.record({
      email: 'biz@example.com',
      tenantId: 'tenant-1',
      purpose: 'checkout',
      documentSlug: 'terms',
      documentVersion: version,
      contentHash,
    });
    await expect(
      service.requireCheckout({
        tenantId: 'tenant-1',
        version,
        contentHash,
        needsArt1341: true,
      }),
    ).rejects.toThrow(/art\. 1341/);
  });

  it('accepts a business checkout only after both acts are recorded', async () => {
    const { version, contentHash } = legal();
    await service.record({
      email: 'biz@example.com',
      tenantId: 'tenant-1',
      purpose: 'checkout',
      documentSlug: 'terms',
      documentVersion: version,
      contentHash,
      billingCode: 'ABCDEFG',
    });
    await service.record({
      email: 'biz@example.com',
      tenantId: 'tenant-1',
      purpose: 'art1341',
      documentSlug: 'terms',
      documentVersion: version,
      contentHash,
    });
    await expect(
      service.requireCheckout({
        tenantId: 'tenant-1',
        version,
        contentHash,
        needsArt1341: true,
      }),
    ).resolves.toBeUndefined();
    const rows = await service.listForTenant('tenant-1');
    expect(rows.map((r) => r.purpose)).toEqual(['art1341', 'checkout']);
    expect(rows.find((r) => r.purpose === 'checkout')?.billingCode).toBe('ABCDEFG');
  });
});
