import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseResult,
} from '../providers/registrar/registrar-provider.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import { GateVerdict } from '../trademark/trademark-gate.js';
import { parseDomain } from '../utils/domain.js';
import { PurchaseNotApprovedError, type PurchaseRecord } from '../types/registrar.js';
import { addYearsToDate } from '../types/acquisition.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface PurchaseCheckResult {
  domain: string;
  available: boolean;
  registerPriceEur: number | null;
  renewalPriceEur: number | null;
  expectedValue: number | null;
  confidence: number | null;
  suggestedBuyMax: number | null;
  trademarkClear: boolean;
  operatorApprovalRequired: boolean;
}

export interface PurchaseExecutionResult {
  success: boolean;
  purchase?: PurchaseRecord | undefined;
  error?: string | undefined;
  message?: string | undefined;
}

export enum AutoApprovalPolicy {
  Never = 'never',
  UnderBuyMax = 'under_buy_max',
  Always = 'always',
}

export class PurchaseService {
  readonly #registrar: RegistrarProvider;
  readonly #portfolioManager: PortfolioManager;
  readonly #outcomeRepo: OutcomeRepository;
  readonly #engine: ScoringEngine | undefined;
  readonly #gate: TrademarkGate | undefined;
  readonly #autoApproval: AutoApprovalPolicy;
  readonly #buyMaxAbsoluteCap: number;

  constructor(options: {
    registrar: RegistrarProvider;
    portfolioManager: PortfolioManager;
    outcomeRepo: OutcomeRepository;
    engine?: ScoringEngine | undefined;
    gate?: TrademarkGate | undefined;
    autoApproval?: AutoApprovalPolicy;
    buyMaxAbsoluteCap?: number;
  }) {
    this.#registrar = options.registrar;
    this.#portfolioManager = options.portfolioManager;
    this.#outcomeRepo = options.outcomeRepo;
    this.#engine = options.engine;
    this.#gate = options.gate;
    this.#autoApproval = options.autoApproval ?? AutoApprovalPolicy.Never;
    this.#buyMaxAbsoluteCap = options.buyMaxAbsoluteCap ?? 500;
  }

  get registrarName(): string {
    return this.#registrar.name;
  }

  async preflight(domain: string): Promise<PurchaseCheckResult> {
    const priceResults = await this.#registrar.checkPrice([domain]);
    const price = priceResults[0];
    if (!price) {
      return {
        domain,
        available: false,
        registerPriceEur: null,
        renewalPriceEur: null,
        expectedValue: null,
        confidence: null,
        suggestedBuyMax: null,
        trademarkClear: false,
        operatorApprovalRequired: true,
      };
    }

    let expectedValue: number | null = null;
    let confidence: number | null = null;
    let suggestedBuyMax: number | null = null;
    let trademarkClear = false;

    if (this.#engine) {
      try {
        const parsed = parseDomain(domain);
        const score = await this.#engine.score({
          domain,
          tld: parsed.tld ?? '',
          sld: parsed.sld,
          isCloseout: false,
        });
        expectedValue = score.expectedValue;
        confidence = score.confidence;
        suggestedBuyMax = score.suggestedBuyMax;
      } catch {
        expectedValue = null;
      }
    }

    if (this.#gate) {
      try {
        const result = await this.#gate.check(domain);
        trademarkClear = result.verdict === GateVerdict.Clear;
      } catch {
        trademarkClear = false;
      }
    }

    const cost = price.registerPriceEur ?? 0;
    const buyMax = suggestedBuyMax ?? this.#buyMaxAbsoluteCap;
    let operatorApprovalRequired = true;

    if (this.#autoApproval === AutoApprovalPolicy.Always) {
      operatorApprovalRequired = false;
    } else if (
      this.#autoApproval === AutoApprovalPolicy.UnderBuyMax &&
      cost > 0 &&
      cost <= buyMax
    ) {
      operatorApprovalRequired = false;
    }

    return {
      domain,
      available: price.available,
      registerPriceEur: price.registerPriceEur,
      renewalPriceEur: price.renewalPriceEur,
      expectedValue,
      confidence,
      suggestedBuyMax,
      trademarkClear,
      operatorApprovalRequired,
    };
  }

  async execute(
    domain: string,
    years: number = 1,
    operatorApproved: boolean = false,
  ): Promise<PurchaseExecutionResult> {
    try {
      const check = await this.preflight(domain);

      // Manual registrar: allow recording purchases made externally.
      // The preflight check is still performed for scoring + TM gate,
      // but we don't call a registrar API for the actual purchase.
      if (this.#registrar.name === 'manual') {
        const tld = parseDomain(domain).tld ?? '';
        const now = new Date();
        await this.#portfolioManager.add({
          domain,
          tld,
          acquiredAt: now.toISOString(),
          renewalDate: addYearsToDate(now, years).toISOString(),
          acquisitionCost: check.registerPriceEur ?? 0,
          renewalCost: check.renewalPriceEur ?? 0,
          registrar: this.#registrar.name,
        });

        await this.#outcomeRepo.insert({
          domain,
          type: 'purchased',
          occurredAt: new Date().toISOString(),
          venue: 'manual',
        });

        logger.info({ domain }, 'Manual purchase recorded in portfolio');

        return {
          success: true,
          message:
            'Manual purchase recorded in portfolio. ' +
            'Use `dominus portfolio update-costs` to set the actual acquisition price.',
          purchase: {
            domain,
            registrar: this.#registrar.name,
            priceEur: check.registerPriceEur ?? 0,
            renewalPriceEur: check.renewalPriceEur ?? 0,
            purchasedAt: new Date().toISOString(),
          },
        };
      }

      if (!check.available) {
        return { success: false, error: `Domain ${domain} is not available for registration` };
      }

      if (check.operatorApprovalRequired && !operatorApproved) {
        throw new PurchaseNotApprovedError(domain, this.#registrar.name);
      }

      const tld = parseDomain(domain).tld ?? '';
      const result: RegistrarPurchaseResult = await this.#registrar.purchase({ domain, years });

      if (!result.success) {
        return { success: false, error: result.error ?? 'Purchase failed at registrar' };
      }

      const now = new Date();
      await this.#portfolioManager.add({
        domain,
        tld,
        acquiredAt: now.toISOString(),
        renewalDate: addYearsToDate(now, years).toISOString(),
        acquisitionCost: result.priceEur,
        renewalCost: result.renewalPriceEur,
        registrar: this.#registrar.name,
      });

      await this.#outcomeRepo.insert({
        domain,
        type: 'purchased',
        occurredAt: new Date().toISOString(),
        salePriceEur: undefined,
        listingPriceEur: undefined,
        venue: this.#registrar.name,
      });

      logger.info(
        { domain, registrar: this.#registrar.name, priceEur: result.priceEur },
        'Domain purchased successfully',
      );

      return {
        success: true,
        message: result.message ?? 'Domain purchased successfully and added to portfolio',
        purchase: {
          domain,
          registrar: this.#registrar.name,
          priceEur: result.priceEur,
          renewalPriceEur: result.renewalPriceEur,
          purchasedAt: new Date().toISOString(),
          orderId: result.orderId,
        },
      };
    } catch (err: unknown) {
      if (err instanceof PurchaseNotApprovedError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ domain, error: message }, 'Purchase failed');
      return { success: false, error: message };
    }
  }

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    return this.#registrar.checkPrice(domains);
  }

  async listManagedDomains(): Promise<
    Array<{ domain: string; expiryDate: string; autoRenew: boolean }>
  > {
    try {
      const domains = await this.#registrar.listDomains();
      return domains.map((d) => ({
        domain: d.domain,
        expiryDate: d.expiryDate,
        autoRenew: d.autoRenew,
      }));
    } catch {
      return [];
    }
  }
}
