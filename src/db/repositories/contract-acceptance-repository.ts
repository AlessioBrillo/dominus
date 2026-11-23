// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';

export type ContractAcceptancePurpose = 'signup' | 'checkout' | 'dpa' | 'art1341';

export interface ContractAcceptance {
  id: number;
  tenantId: string | null;
  /** Identifier of the accepting subject: email at signup, session subject at checkout. */
  email: string;
  purpose: ContractAcceptancePurpose;
  documentSlug: string;
  documentVersion: string;
  contentHash: string;
  ipHash: string | null;
  userAgentHash: string | null;
  checkoutSessionId: string | null;
  billingCode: string | null;
  acceptedAt: string;
}

interface ContractAcceptanceRow {
  id: number;
  tenant_id: string | null;
  email: string;
  purpose: string;
  document_slug: string;
  document_version: string;
  content_hash: string;
  ip_hash: string | null;
  user_agent_hash: string | null;
  checkout_session_id: string | null;
  billing_code: string | null;
  accepted_at: string;
}

function acceptanceFromRow(row: ContractAcceptanceRow): ContractAcceptance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    purpose: row.purpose as ContractAcceptancePurpose,
    documentSlug: row.document_slug,
    documentVersion: row.document_version,
    contentHash: row.content_hash,
    ipHash: row.ip_hash,
    userAgentHash: row.user_agent_hash,
    checkoutSessionId: row.checkout_session_id,
    billingCode: row.billing_code,
    acceptedAt: row.accepted_at,
  };
}

export interface NewContractAcceptance {
  tenantId?: string | null;
  email: string;
  purpose: ContractAcceptancePurpose;
  documentSlug: string;
  documentVersion: string;
  contentHash: string;
  ipHash?: string | null;
  userAgentHash?: string | null;
  checkoutSessionId?: string | null;
  billingCode?: string | null;
}

/**
 * The append-only ledger of contract acceptances.
 *
 * Rows are never updated or deleted by the application: an acceptance is a
 * historical fact about a specific version of a document. Deletion happens
 * only through the data-subject erasure path, which removes every row for a
 * tenant (or for an email address that never became a tenant).
 */
export class ContractAcceptanceRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async create(input: NewContractAcceptance): Promise<ContractAcceptance> {
    const row = await this.#db.queryOne<ContractAcceptanceRow>(
      `INSERT INTO contract_acceptances
         (tenant_id, email, purpose, document_slug, document_version, content_hash,
          ip_hash, user_agent_hash, checkout_session_id, billing_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [
        input.tenantId ?? null,
        input.email,
        input.purpose,
        input.documentSlug,
        input.documentVersion,
        input.contentHash,
        input.ipHash ?? null,
        input.userAgentHash ?? null,
        input.checkoutSessionId ?? null,
        input.billingCode ?? null,
      ],
    );
    if (!row) throw new Error('The contract acceptance could not be stored');
    return acceptanceFromRow(row);
  }

  /** True when a matching acceptance exists for the given tenant and purpose. */
  async hasForTenant(
    tenantId: string,
    purpose: ContractAcceptancePurpose,
    documentSlug: string,
    documentVersion: string,
    contentHash: string,
    maxAgeMs: number,
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const row = await this.#db.queryOne<{ id: number }>(
      `SELECT id FROM contract_acceptances
        WHERE tenant_id = ? AND purpose = ? AND document_slug = ? AND document_version = ?
          AND content_hash = ? AND accepted_at >= ?
        ORDER BY accepted_at DESC LIMIT 1`,
      [tenantId, purpose, documentSlug, documentVersion, contentHash, cutoff],
    );
    return row !== null;
  }

  async listForTenant(tenantId: string): Promise<ContractAcceptance[]> {
    const rows = await this.#db.query<ContractAcceptanceRow>(
      'SELECT * FROM contract_acceptances WHERE tenant_id = ? ORDER BY accepted_at DESC',
      [tenantId],
    );
    return rows.map(acceptanceFromRow);
  }

  async listForEmail(email: string): Promise<ContractAcceptance[]> {
    const rows = await this.#db.query<ContractAcceptanceRow>(
      'SELECT * FROM contract_acceptances WHERE email = ? ORDER BY accepted_at DESC',
      [email],
    );
    return rows.map(acceptanceFromRow);
  }

  /** Used by the data-subject erasure job. */
  async deleteForTenant(tenantId: string): Promise<number> {
    const result = await this.#db.exec('DELETE FROM contract_acceptances WHERE tenant_id = ?', [
      tenantId,
    ]);
    return result.changes;
  }

  async deleteForEmail(email: string): Promise<number> {
    const result = await this.#db.exec('DELETE FROM contract_acceptances WHERE email = ?', [email]);
    return result.changes;
  }
}
