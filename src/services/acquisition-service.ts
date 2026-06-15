import type { AcquisitionRepository } from '../db/repositories/acquisition-repository.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import type { Bid, PlaceBidInput, ResolveBidInput } from '../types/acquisition.js';
import { BidStatus, addYearsToDate } from '../types/acquisition.js';
import { DuplicateDomainError } from '../types/errors.js';
import { getLogger } from '../logger.js';
import { parseDomain } from '../utils/domain.js';
import type Database from 'better-sqlite3';

const logger = getLogger();

export class AcquisitionService {
  readonly #repo: AcquisitionRepository;
  readonly #portfolioManager: PortfolioManager;
  readonly #outcomeRepo: OutcomeRepository;
  readonly #db: Database.Database;

  constructor(
    repo: AcquisitionRepository,
    portfolioManager: PortfolioManager,
    outcomeRepo: OutcomeRepository,
    db: Database.Database,
  ) {
    this.#repo = repo;
    this.#portfolioManager = portfolioManager;
    this.#outcomeRepo = outcomeRepo;
    this.#db = db;
  }

  async place(input: PlaceBidInput): Promise<Bid> {
    if (input.bidAmountEur <= 0) {
      throw new Error('Bid amount must be positive');
    }

    const existing = this.#repo.findByDomain(input.domain);
    if (existing !== null && existing.status === BidStatus.Pending) {
      throw new Error(
        `Domain ${input.domain} already has a pending bid (placed ${existing.bidPlacedAt}). Cancel it first or wait for resolution.`,
      );
    }

    const bid = this.#repo.insert(input);
    logger.info({ domain: bid.domain, venue: bid.venue, amount: bid.bidAmountEur }, 'Bid placed');
    return bid;
  }

  async resolve(input: ResolveBidInput): Promise<Bid> {
    const existing = this.#repo.findByDomain(input.domain);
    if (existing === null) {
      throw new Error(`No bid found for domain ${input.domain}`);
    }
    if (existing.status !== BidStatus.Pending) {
      throw new Error(
        `Bid for ${input.domain} is already ${existing.status} (resolved ${existing.resolvedAt})`,
      );
    }

    const transaction = this.#db.transaction((): Bid => {
      const resolved = this.#repo.resolve(
        input.domain,
        input.status,
        input.wonPriceEur,
        input.notes,
      );
      if (resolved === null) {
        throw new Error(`Failed to resolve bid for ${input.domain}`);
      }

      if (input.status === BidStatus.Won) {
        const parsed = parseDomain(input.domain);
        const price = input.wonPriceEur ?? existing.bidAmountEur;
        const now = new Date();
        const years = input.registrationYears ?? 1;

        this.#portfolioManager.add({
          domain: input.domain,
          tld: parsed.tld,
          acquiredAt: now.toISOString(),
          renewalDate: addYearsToDate(now, years).toISOString(),
          acquisitionCost: price,
          renewalCost: 0,
          registrar: existing.venue,
          notes: input.notes,
        });

        this.#outcomeRepo.insert({
          domain: input.domain,
          type: 'purchased',
          occurredAt: now.toISOString(),
          salePriceEur: input.wonPriceEur,
          venue: existing.venue,
          notes: `Won auction on ${existing.venue}, bid €${existing.bidAmountEur}`,
        });
      }

      return resolved;
    });

    try {
      const result = transaction();
      logger.info({ domain: input.domain, status: input.status }, `Bid resolved: ${input.status}`);
      return result;
    } catch (err: unknown) {
      if (err instanceof DuplicateDomainError) {
        const dupError = new Error(
          `Domain ${input.domain} is already in the portfolio. Resolve the bid as lost/cancelled or remove the portfolio entry first.`,
        );
        dupError.cause = err;
        throw dupError;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ domain: input.domain, error: message }, 'Failed to resolve bid');
      throw err;
    }
  }

  async list(status?: BidStatus): Promise<Bid[]> {
    if (status !== undefined) {
      return this.#repo.findByStatus(status);
    }
    return this.#repo.findAll();
  }

  async pending(): Promise<Bid[]> {
    return this.#repo.findPending();
  }

  async get(domain: string): Promise<Bid | null> {
    return this.#repo.findByDomain(domain);
  }
}
