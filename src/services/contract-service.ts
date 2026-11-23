// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type {
  ContractAcceptance,
  ContractAcceptancePurpose,
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

/** The documents as published by this deployment, captured once at boot. */
export interface PublishedContractDocuments {
  version: string;
  documentHashes: Record<string, string>;
}

export interface DocumentRef {
  version: string;
  documentHashes: Record<string, string>;
}

/**
 * The contract-acceptance ledger.
 *
 * The acts are recorded by the AUTHENTICATED routes (signup and checkout),
 * not by a public "I accept" endpoint: a client that can choose whose email
 * and tenant it is accepting for would turn the evidence into a forgery.
 * The version and the per-document hash come from the text built at boot, so
 * a client cannot name a document version the operator never published.
 */
export class ContractService {
  readonly #repo: ContractAcceptanceRepository;
  readonly #published: PublishedContractDocuments;

  constructor(repo: ContractAcceptanceRepository, published: PublishedContractDocuments) {
    this.#repo = repo;
    this.#published = published;
  }

  get published(): PublishedContractDocuments {
    return this.#published;
  }

  /** Validate a client-supplied reference before any write happens. */
  validateReference(ref: DocumentRef, slugs: readonly string[] = ['terms']): void {
    for (const slug of slugs) this.#validate(slug, ref);
  }

  async #record(
    input: NewContractAcceptance & { ip?: string | null; userAgent?: string | null },
  ): Promise<ContractAcceptance> {
    if (!input.email || input.email.trim() === '') {
      throw new ContractAcceptanceError('An accepting subject is required');
    }
    return this.#repo.create({
      ...input,
      ipHash: input.ip ? hashIdentifier(input.ip) : null,
      userAgentHash: input.userAgent ? hashIdentifier(input.userAgent) : null,
    });
  }

  #validate(slug: string, ref: DocumentRef): void {
    const expected = this.#published.documentHashes[slug];
    if (
      ref.version !== this.#published.version ||
      !expected ||
      ref.documentHashes?.[slug] !== expected
    ) {
      throw new ContractAcceptanceError(
        `The acceptance does not match the published version of the ${slug}`,
      );
    }
  }

  /** Called by the authenticated signup route after the workspace exists. */
  async recordSignup(input: {
    subject: string;
    tenantId: string;
    ref: DocumentRef;
    termsAccepted: boolean;
    privacyAccepted: boolean;
    ageConfirmed: boolean;
  }): Promise<void> {
    if (!input.termsAccepted || !input.privacyAccepted || !input.ageConfirmed) {
      throw new ContractAcceptanceError(
        'The terms, the privacy notice and the age declaration must all be accepted',
      );
    }
    this.#validate('terms', input.ref);
    this.#validate('privacy', input.ref);
    for (const slug of ['terms', 'privacy', 'age']) {
      await this.#record({
        email: input.subject,
        tenantId: input.tenantId,
        purpose: 'signup',
        documentSlug: slug,
        documentVersion: this.#published.version,
        contentHash: this.#published.documentHashes[slug] ?? this.#published.documentHashes.terms!,
      });
    }
  }

  /** Called by the authenticated checkout route before Stripe is opened. */
  async recordCheckout(input: {
    subject: string;
    tenantId: string;
    ref: DocumentRef;
    immediatePerformance: boolean;
    businessCustomer: boolean;
    art1341Approved?: boolean;
    dpaAccepted?: boolean;
    billingCode?: string;
  }): Promise<void> {
    this.#validate('terms', input.ref);
    if (!input.immediatePerformance) {
      throw new ContractAcceptanceError(
        'The express request to start the service immediately is required',
      );
    }
    // Validate the whole act before writing any of it: a failed business
    // checkout must not leave a partial set of acceptances behind.
    if (
      input.businessCustomer &&
      (!input.art1341Approved || !input.dpaAccepted || !input.billingCode?.trim())
    ) {
      throw new ContractAcceptanceError(
        'A business customer must approve art. 1341 c.c., accept the DPA and provide the SDI code or PEC',
      );
    }
    const version = this.#published.version;
    const termsHash = this.#published.documentHashes.terms!;
    await this.#record({
      email: input.subject,
      tenantId: input.tenantId,
      purpose: 'checkout',
      documentSlug: 'terms',
      documentVersion: version,
      contentHash: termsHash,
      billingCode: input.billingCode ?? null,
    });
    await this.#record({
      email: input.subject,
      tenantId: input.tenantId,
      purpose: 'checkout',
      documentSlug: 'withdrawal',
      documentVersion: version,
      contentHash: termsHash,
    });
    if (input.businessCustomer) {
      await this.#record({
        email: input.subject,
        tenantId: input.tenantId,
        purpose: 'art1341',
        documentSlug: 'terms',
        documentVersion: version,
        contentHash: termsHash,
      });
      await this.#record({
        email: input.subject,
        tenantId: input.tenantId,
        purpose: 'dpa',
        documentSlug: 'dpa',
        documentVersion: version,
        contentHash: termsHash,
      });
    }
  }

  /** Fail-closed re-check used by the billing router. */
  async requireCheckout(input: {
    tenantId: string;
    ref: DocumentRef;
    needsArt1341: boolean;
  }): Promise<void> {
    this.#validate('terms', input.ref);
    const version = this.#published.version;
    const termsHash = this.#published.documentHashes.terms!;
    for (const [purpose, slug] of [
      ['checkout', 'terms'],
      ['checkout', 'withdrawal'],
    ] as const) {
      const found = await this.#has(input.tenantId, purpose, slug, version, termsHash);
      if (!found) {
        throw new ContractAcceptanceError(
          `A current ${slug} acceptance is required before checkout`,
        );
      }
    }
    if (input.needsArt1341) {
      for (const [purpose, slug] of [
        ['art1341', 'terms'],
        ['dpa', 'dpa'],
      ] as const) {
        const found = await this.#has(input.tenantId, purpose, slug, version, termsHash);
        if (!found) {
          throw new ContractAcceptanceError(
            `A current ${purpose} acceptance is required before checkout`,
          );
        }
      }
    }
  }

  async #has(
    tenantId: string,
    purpose: ContractAcceptancePurpose,
    slug: string,
    version: string,
    hash: string,
  ): Promise<boolean> {
    return this.#repo.hasForTenant(tenantId, purpose, slug, version, hash, ACCEPTANCE_MAX_AGE_MS);
  }

  async listForTenant(tenantId: string): Promise<ContractAcceptance[]> {
    return this.#repo.listForTenant(tenantId);
  }
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Created once at boot (after migrations) and read by the routers. The
 * setter keeps the existing router signatures; the guardrail asserts that
 * production wires it.
 */
let instance: ContractService | undefined;

export function setContractService(service: ContractService): void {
  instance = service;
}

/** Undefined only in unit tests that mount a router on its own. */
export function getContractService(): ContractService | undefined {
  return instance;
}
