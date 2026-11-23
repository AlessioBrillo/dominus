// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type {
  ContractAcceptance,
  ContractAcceptanceRepository,
  NewContractAcceptance,
} from '../db/repositories/contract-acceptance-repository.js';

/** An acceptance older than this is not enough to start a new checkout. */
const ACCEPTANCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class ContractAcceptanceError extends Error {
  readonly code = 'CONTRACT_ACCEPTANCE_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'ContractAcceptanceError';
  }
}

export interface RecordAcceptanceInput extends NewContractAcceptance {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * The contract-acceptance ledger.
 *
 * Stripe's `consent_collection` gives one checkbox and no durable record we
 * control. The payment is made in Stripe, but the CONTRACT is made here: the
 * customer accepts a specific version and hash of the terms, asks for
 * immediate performance (art. 57(3) Consumer Code), and — when it is a
 * business — specifically approves the clauses that limit its rights
 * (art. 1341 c.c.). All three acts are recorded in one append-only ledger.
 */
export class ContractService {
  readonly #repo: ContractAcceptanceRepository;

  constructor(repo: ContractAcceptanceRepository) {
    this.#repo = repo;
  }

  async record(input: RecordAcceptanceInput): Promise<ContractAcceptance> {
    if (!input.email || input.email.trim() === '') {
      throw new ContractAcceptanceError('An email address is required to record an acceptance');
    }
    if (!input.documentVersion || !input.contentHash) {
      throw new ContractAcceptanceError('The document version and hash are required');
    }
    return this.#repo.create({
      ...input,
      email: input.email.trim().toLowerCase(),
      ipHash: input.ip ? hashIdentifier(input.ip) : null,
      userAgentHash: input.userAgent ? hashIdentifier(input.userAgent) : null,
    });
  }

  /**
   * Fail-closed check used before a checkout session is created.
   *
   * The version and hash must match the documents the customer actually saw;
   * an acceptance of an older version does not carry over silently.
   */
  async requireCheckout(input: {
    tenantId: string;
    version: string;
    contentHash: string;
    needsArt1341: boolean;
  }): Promise<void> {
    const terms = await this.#repo.hasForTenant(
      input.tenantId,
      'checkout',
      'terms',
      input.version,
      ACCEPTANCE_MAX_AGE_MS,
    );
    if (!terms) {
      throw new ContractAcceptanceError(
        'The terms and the request for immediate performance must be accepted before checkout',
      );
    }
    if (input.needsArt1341) {
      const art1341 = await this.#repo.hasForTenant(
        input.tenantId,
        'art1341',
        'terms',
        input.version,
        ACCEPTANCE_MAX_AGE_MS,
      );
      if (!art1341) {
        throw new ContractAcceptanceError(
          'Business customers must specifically approve sections 13, 14 and 17 under art. 1341 c.c. before checkout',
        );
      }
    }
  }

  async requireSignup(input: {
    email: string;
    version: string;
    contentHash: string;
  }): Promise<void> {
    const accepted = await this.#repo.listForEmail(input.email.trim().toLowerCase());
    const match = accepted.some(
      (a) =>
        a.purpose === 'signup' &&
        a.documentSlug === 'terms' &&
        a.documentVersion === input.version &&
        a.contentHash === input.contentHash,
    );
    if (!match) {
      throw new ContractAcceptanceError(
        'The terms and privacy notice must be accepted before a workspace is created',
      );
    }
  }

  async listForTenant(tenantId: string): Promise<ContractAcceptance[]> {
    return this.#repo.listForTenant(tenantId);
  }
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * The service is created once at boot (after the migrations have run) and
 * read by the routers. The setter exists so the routers keep their existing
 * signatures: adding a sixth argument to createAuthRouter would break every
 * caller and every test for a dependency that only production has.
 */
let instance: ContractService | undefined;

export function setContractService(service: ContractService): void {
  instance = service;
}

/** The configured service, or undefined in tests and community deployments. */
export function getContractService(): ContractService | undefined {
  return instance;
}
