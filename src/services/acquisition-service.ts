import type { AcquisitionRepository } from '../db/repositories/acquisition-repository.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import type { Bid, PlaceBidInput, ResolveBidInput } from '../types/acquisition.js';
import { BidStatus, addYearsToDate } from '../types/acquisition.js';
import { DuplicateDomainError } from '../types/errors.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import { GateVerdict } from '../trademark/trademark-gate.js';
import type { DatabaseProvider } from '../db/provider/interface.js';
import { getLogger } from '../logger.js';
import { parseDomain } from '../utils/domain.js';

const logger = getLogger();

export class AcquisitionService {
  readonly #repo: AcquisitionRepository;
  readonly #portfolioManager: PortfolioManager;
  readonly #outcomeRepo: OutcomeRepository;
  readonly #db: DatabaseProvider;
  readonly #engine: ScoringEngine | undefined;
  readonly #gate: TrademarkGate | undefined;

  constructor(
    repo: AcquisitionRepository,
    portfolioManager: PortfolioManager,
    outcomeRepo: OutcomeRepository,
    db: DatabaseProvider,
    engine?: ScoringEngine,
    gate?: TrademarkGate,
  ) {
    this.#repo = repo;
    this.#portfolioManager = portfolioManager;
    this.#outcomeRepo = outcomeRepo;
    this.#db = db;
    this.#engine = engine;
    this.#gate = gate;
  }

  async place(input: PlaceBidInput): Promise<Bid> {
    if (input.bidAmountEur <= 0) {
      throw new Error('Bid amount must be positive');
    }

    const existing = await this.#repo.findByDomain(input.domain);
    if (existing !== null && existing.status === BidStatus.Pending) {
      throw new Error(
        `Domain ${input.domain} already has a pending bid (placed ${existing.bidPlacedAt}). Cancel it first or wait for resolution.`,
      );
    }

    if (this.#engine) {
      try {
        const parsed = parseDomain(input.domain);
        const score = await this.#engine.score({
          domain: input.domain,
          tld: parsed.tld ?? '',
          sld: parsed.sld,
          isCloseout: false,
        });
        if (!score.recommended && score.confidence > 0) {
          logger.warn(
            { domain: input.domain, score: score.expectedValue, confidence: score.confidence },
            'Bid placed on non-recommended domain — scoring engine does not recommend purchase',
          );
        }
      } catch (err) {
        logger.warn(
          { domain: input.domain, err },
          'Failed to re-score domain during bid placement — proceeding without score verification',
        );
      }
    }

    if (this.#gate) {
      try {
        const result = await this.#gate.check(input.domain);
        if (result.verdict === GateVerdict.Blocked) {
          const detail = result.matchedMark
            ? `matched mark "${result.matchedMark}" on ${result.matchSource ?? result.verifiedSources.join(', ')}`
            : `trademark match on ${result.verifiedSources.join(', ')}`;
          throw new Error(
            `Domain ${input.domain} is blocked by trademark gate (${detail}). ` +
              'Bid rejected: trademark check is non-negotiable.',
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('blocked by trademark gate')) {
          throw err;
        }
        logger.warn(
          { domain: input.domain, err },
          'Trademark check failed during bid placement — proceeding without TM verification',
        );
      }
    }

    const bid = await this.#repo.insert(input);
    logger.info({ domain: bid.domain, venue: bid.venue, amount: bid.bidAmountEur }, 'Bid placed');
    return bid;
  }

  async resolve(input: ResolveBidInput): Promise<Bid> {
    const existing = await this.#repo.findByDomain(input.domain);
    if (existing === null) {
      throw new Error(`No bid found for domain ${input.domain}`);
    }
    if (existing.status !== BidStatus.Pending) {
      throw new Error(
        `Bid for ${input.domain} is already ${existing.status} (resolved ${existing.resolvedAt})`,
      );
    }

    return this.#db
      .transaction(async () => {
        const resolved = await this.#repo.resolve(
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

          await this.#portfolioManager.add({
            domain: input.domain,
            tld: parsed.tld,
            acquiredAt: now.toISOString(),
            renewalDate: addYearsToDate(now, years).toISOString(),
            acquisitionCost: price,
            renewalCost: 0,
            registrar: existing.venue,
            notes: input.notes,
          });

          await this.#outcomeRepo.insert({
            domain: input.domain,
            type: 'purchased',
            occurredAt: now.toISOString(),
            salePriceEur: input.wonPriceEur,
            venue: existing.venue,
            notes: `Won auction on ${existing.venue}, bid €${existing.bidAmountEur}`,
          });
        }

        logger.info(
          { domain: input.domain, status: input.status },
          `Bid resolved: ${input.status}`,
        );
        return resolved;
      })
      .catch((err: unknown) => {
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
      });
  }

  async list(status?: BidStatus): Promise<Bid[]> {
    if (status !== undefined) {
      return await this.#repo.findByStatus(status);
    }
    return await this.#repo.findAll();
  }

  async pending(): Promise<Bid[]> {
    return await this.#repo.findPending();
  }

  async get(domain: string): Promise<Bid | null> {
    return await this.#repo.findByDomain(domain);
  }
}
