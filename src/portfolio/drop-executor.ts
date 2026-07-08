import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import type { PortfolioEntry } from '../types/portfolio.js';
import { Verdict } from '../types/portfolio.js';
import type { Notifier } from '../notifiers/notifier.js';
import type { Notification } from '../types/alert.js';
import { AlertType, AlertSeverity } from '../types/alert.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface DropExecutionResult {
  executed: string[];
  skipped: Array<{ domain: string; reason: string }>;
  errors: Array<{ domain: string; error: string }>;
}

export interface DropExecutorConfig {
  /**
   * Minimum days since last 'dropped' outcome before we can re-drop.
   * Prevents repeated executions on the same domain within a cycle.
   * Default: 30 days.
   */
  cooldownDays: number;
  /**
   * When true, log the intended action but don't execute it.
   * Default: false.
   */
  dryRun: boolean;
}

export const DEFAULT_DROP_EXECUTOR_CONFIG: DropExecutorConfig = {
  cooldownDays: 30,
  dryRun: false,
};

/**
 * Executes drop verdicts: removes domains from the portfolio and records
 * the outcome for historical tracking.
 *
 * The executor is idempotent: it will not execute a drop for a domain
 * that already has a 'dropped' outcome within the cooldown window.
 * This prevents the scheduler from repeatedly dropping a domain that
 * was already actioned.
 */
export class DropExecutor {
  readonly #portfolioRepo: PortfolioRepository;
  readonly #outcomeRepo: OutcomeRepository;
  readonly #notifiers: Notifier[];
  readonly #config: DropExecutorConfig;

  constructor(
    portfolioRepo: PortfolioRepository,
    outcomeRepo: OutcomeRepository,
    notifiers: Notifier[],
    config: Partial<DropExecutorConfig> = {},
  ) {
    this.#portfolioRepo = portfolioRepo;
    this.#outcomeRepo = outcomeRepo;
    this.#notifiers = notifiers;
    this.#config = { ...DEFAULT_DROP_EXECUTOR_CONFIG, ...config };
  }

  /**
   * Execute all pending drop verdicts.
   * Returns a summary of what was executed, skipped, and errored.
   */
  async executeAll(): Promise<DropExecutionResult> {
    const entries = await this.#portfolioRepo.findAll();
    const dropEntries = entries.filter((e) => e.verdict === Verdict.Drop);

    logger.info({ dropCandidates: dropEntries.length }, 'DropExecutor: scanning portfolio');

    const result: DropExecutionResult = { executed: [], skipped: [], errors: [] };

    for (const entry of dropEntries) {
      try {
        const outcome = await this.#handleDrop(entry);
        if (outcome.executed) result.executed.push(entry.domain);
        else result.skipped.push({ domain: entry.domain, reason: outcome.reason! });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ domain: entry.domain, error: message });
        logger.error({ domain: entry.domain, err }, 'DropExecutor: failed to execute drop');
      }
    }

    logger.info(
      {
        executed: result.executed.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
      },
      'DropExecutor: complete',
    );

    return result;
  }

  async #handleDrop(entry: PortfolioEntry): Promise<{ executed: boolean; reason?: string }> {
    // Idempotency guard: check if already dropped within cooldown window.
    const recentDrops = await this.#outcomeRepo.findByDomain(entry.domain);
    const lastDrop = recentDrops.find((o) => o.type === 'dropped');
    if (lastDrop) {
      const daysSince = daysBetween(new Date(lastDrop.occurredAt), new Date());
      if (daysSince < this.#config.cooldownDays) {
        return {
          executed: false,
          reason: `Already dropped ${Math.round(daysSince)} days ago (cooldown: ${this.#config.cooldownDays}d)`,
        };
      }
    }

    if (this.#config.dryRun) {
      logger.info({ domain: entry.domain }, 'DropExecutor: dry-run — would drop domain');
      return { executed: false, reason: 'dry-run' };
    }

    // Record the drop outcome.
    await this.#outcomeRepo.insert({
      domain: entry.domain,
      type: 'dropped',
      occurredAt: new Date().toISOString(),
      acquisitionCostEur: entry.acquisitionCost,
      totalRenewalCostEur: entry.renewalCost,
      notes: `Drop verdict executed. Last score: ${entry.currentScore ?? 'N/A'}`,
    });

    // Update verdict to executed status.
    await this.#portfolioRepo.updateVerdict(
      entry.domain,
      Verdict.Drop,
      'Executed — domain removed from portfolio',
    );

    // Notify.
    const notification: Notification = {
      alertType: AlertType.ScoreDropped,
      severity: AlertSeverity.Info,
      message: `Drop executed: ${entry.domain} was removed from portfolio per drop verdict`,
      domain: entry.domain,
      createdAt: new Date().toISOString(),
    };
    await Promise.allSettled(this.#notifiers.map((n) => n.send(notification)));

    logger.info({ domain: entry.domain }, 'DropExecutor: drop executed');
    return { executed: true };
  }
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.abs(b.getTime() - a.getTime()) / msPerDay;
}
