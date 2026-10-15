// SPDX-License-Identifier: AGPL-3.0-only
import type { PostAcquisitionRepository } from '../db/repositories/post-acquisition-repository.js';
import type { AutomationAuditRepository } from '../db/repositories/automation-audit-repository.js';
import type { TenantAutomationSettingsRepository } from '../db/repositories/tenant-automation-settings-repository.js';
import type {
  AutomationSettings,
  AutomationSettingsView,
  EffectiveAutomationSettings,
  PostAcquisitionRunResult,
  PostAcquisitionRunStepResult,
  PostAcquisitionStep,
  PostAcquisitionStepName,
  PostAcquisitionStepStatus,
  PostAcquisitionTriggerSource,
  TenantAutomationSettings,
  TenantAutomationSettingsUpdate,
} from '../types/automation.js';
import type { AutomationAuditEntry } from '../types/automation.js';
import { POST_ACQUISITION_STEPS } from '../types/automation.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface PostAcquisitionStepContext {
  domain: string;
  source: PostAcquisitionTriggerSource;
  pipelineRunId: string | null;
  /** True when the pipeline runs in dry-run mode: executors that spend
   *  money or mutate DNS must skip instead of acting. */
  dryRun: boolean;
  signal?: AbortSignal | undefined;
}

export type PostAcquisitionStepOutcome =
  | { status: 'done'; message?: string; detail?: Record<string, unknown> }
  | { status: 'skipped'; reason: string; detail?: Record<string, unknown> }
  | { status: 'failed'; error: string; detail?: Record<string, unknown> };

export interface PostAcquisitionStepExecutor {
  readonly step: PostAcquisitionStepName;
  execute(ctx: PostAcquisitionStepContext): Promise<PostAcquisitionStepOutcome>;
}

/** Entry point used by purchase/acquisition flows and the job queue. */
export interface PostAcquisitionTrigger {
  /** Enqueue (or, without a worker, run) the pipeline for a domain. */
  trigger(
    domain: string,
    source: PostAcquisitionTriggerSource,
    pipelineRunId?: string | null,
  ): Promise<string>;
}

export interface PostAcquisitionRunOptions {
  signal?: AbortSignal | undefined;
  pipelineRunId?: string | null;
}

export interface PostAcquisitionServiceOptions {
  /** Kill switch (AUTOMATION_ENABLED). When false every run is refused. */
  enabled?: boolean;
  /** Dry-run flag (AUTOMATION_DRY_RUN) forwarded to every executor. */
  dryRun?: boolean;
  /**
   * Per-tenant opt-in store (ADR-0083, Phase 0). When wired, the
   * effective gate combines the operator brake above with the tenant's
   * own switch: enabled = env AND tenant, dry-run = env OR tenant.
   * When absent (community CLI without a settings store, tests) the
   * env flags alone decide, preserving the original behaviour.
   */
  settingsRepo?: TenantAutomationSettingsRepository | undefined;
}

/**
 * Orchestrates the post-acquisition automation pipeline (ADR-0083).
 *
 * Steps run in POST_ACQUISITION_STEPS order, each one journaled in
 * post_acquisition_steps (idempotent: a completed step is never re-run
 * until reset) and audited in automation_audit. A failed step halts the
 * chain — downstream steps depend on its result — and leaves the journal
 * in `failed` so a re-run (or an operator reset) can resume from there.
 */
export class PostAcquisitionService {
  readonly #repo: PostAcquisitionRepository;
  readonly #auditRepo: AutomationAuditRepository;
  readonly #executors = new Map<PostAcquisitionStepName, PostAcquisitionStepExecutor>();
  readonly #enabled: boolean;
  readonly #dryRun: boolean;
  readonly #settingsRepo: TenantAutomationSettingsRepository | undefined;
  /** In-process per-domain serialization: two triggers for the same domain
   *  (purchase + manual run, or a retried job) must never interleave — both
   *  would otherwise pass the "already done" check before either completes. */
  readonly #running = new Map<string, Promise<PostAcquisitionRunResult>>();

  constructor(
    repo: PostAcquisitionRepository,
    auditRepo: AutomationAuditRepository,
    executors: PostAcquisitionStepExecutor[] = [],
    options: PostAcquisitionServiceOptions = {},
  ) {
    this.#repo = repo;
    this.#auditRepo = auditRepo;
    this.#enabled = options.enabled ?? false;
    this.#dryRun = options.dryRun ?? true;
    this.#settingsRepo = options.settingsRepo;
    for (const executor of executors) {
      this.#executors.set(executor.step, executor);
    }
  }

  get settings(): AutomationSettings {
    return { enabled: this.#enabled, dryRun: this.#dryRun };
  }

  /**
   * Full settings view: the operator brake (env), this tenant's switch
   * and the effective combination the pipeline enforces.
   */
  async getSettingsView(): Promise<AutomationSettingsView> {
    const tenant = this.#settingsRepo
      ? await this.#settingsRepo.get()
      : ({ enabled: this.#enabled, dryRun: this.#dryRun } satisfies TenantAutomationSettings);
    return { global: this.settings, tenant, effective: this.#effective(tenant) };
  }

  /** Update this tenant's switch. Returns the stored settings. */
  async updateTenantSettings(
    update: TenantAutomationSettingsUpdate,
  ): Promise<TenantAutomationSettings> {
    if (!this.#settingsRepo) {
      throw new Error(
        'Tenant automation settings are not available: no settings store is configured',
      );
    }
    return this.#settingsRepo.set(update);
  }

  /** Conservative combination: the operator brake can only ever tighten. */
  #effective(tenant: TenantAutomationSettings): EffectiveAutomationSettings {
    if (!this.#enabled) {
      return { enabled: false, dryRun: true, refusedBy: 'global_kill_switch' };
    }
    if (!tenant.enabled) {
      return { enabled: false, dryRun: this.#dryRun || tenant.dryRun, refusedBy: 'tenant_switch' };
    }
    return { enabled: true, dryRun: this.#dryRun || tenant.dryRun };
  }

  /** Register an additional step executor (used by later milestones). */
  registerExecutor(executor: PostAcquisitionStepExecutor): void {
    this.#executors.set(executor.step, executor);
  }

  async run(
    domain: string,
    source: PostAcquisitionTriggerSource,
    options: PostAcquisitionRunOptions = {},
  ): Promise<PostAcquisitionRunResult> {
    // Serialize concurrent runs for the same domain (see #running).
    const previous = this.#running.get(domain);
    const current = (previous ?? Promise.resolve()).then(() =>
      this.#runInternal(domain, source, options),
    );
    this.#running.set(domain, current);
    try {
      return await current;
    } finally {
      if (this.#running.get(domain) === current) {
        this.#running.delete(domain);
      }
    }
  }

  async #runInternal(
    domain: string,
    source: PostAcquisitionTriggerSource,
    options: PostAcquisitionRunOptions,
  ): Promise<PostAcquisitionRunResult> {
    if (!this.#enabled) {
      logger.warn({ domain, source }, 'PostAcquisitionService: automation disabled (kill switch)');
      await this.#audit(domain, 'automation_disabled', source);
      return {
        domain,
        source,
        enabled: false,
        dryRun: true,
        steps: [],
        refusedBy: 'global_kill_switch',
      };
    }

    const tenant = this.#settingsRepo
      ? await this.#settingsRepo.get()
      : ({ enabled: true, dryRun: false } satisfies TenantAutomationSettings);
    const effective = this.#effective(tenant);
    if (!effective.enabled) {
      logger.warn(
        { domain, source },
        'PostAcquisitionService: automation disabled for tenant (opt-in required)',
      );
      await this.#audit(domain, 'tenant_automation_disabled', source);
      return {
        domain,
        source,
        enabled: false,
        dryRun: effective.dryRun,
        steps: [],
        refusedBy: 'tenant_switch',
      };
    }

    const pipelineRunId = options.pipelineRunId ?? null;
    await this.#audit(domain, 'automation_run_started', source, { dryRun: effective.dryRun });

    const stepResults: PostAcquisitionRunStepResult[] = [];

    for (const step of POST_ACQUISITION_STEPS) {
      const executor = this.#executors.get(step);
      if (executor === undefined) {
        stepResults.push({ step, status: 'skipped', message: 'no executor registered' });
        continue;
      }

      const existing = await this.#repo.findByDomainAndStep(domain, step);
      if (existing !== null && existing.status === 'done') {
        stepResults.push({ step, status: 'done', message: 'already completed' });
        continue;
      }

      if (options.signal?.aborted) {
        stepResults.push({ step, status: 'skipped', message: 'aborted before execution' });
        break;
      }

      const row = existing ?? (await this.#repo.upsert({ domain, step, source, pipelineRunId }));
      await this.#repo.incrementAttempts(row.id);

      try {
        const outcome = await executor.execute({
          domain,
          source,
          pipelineRunId,
          dryRun: effective.dryRun,
          signal: options.signal,
        });

        if (outcome.status === 'done') {
          await this.#repo.markDone(row.id, outcome.detail ?? null);
          stepResults.push({
            step,
            status: 'done',
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
          });
          await this.#audit(domain, `step_${step}_done`, source, outcome.detail ?? null);
        } else if (outcome.status === 'skipped') {
          if (outcome.detail !== undefined) {
            await this.#repo.markSkipped(row.id, outcome.reason, outcome.detail);
          } else {
            await this.#repo.markSkipped(row.id, outcome.reason);
          }
          stepResults.push({ step, status: 'skipped', message: outcome.reason });
          await this.#audit(domain, `step_${step}_skipped`, source, { reason: outcome.reason });
        } else {
          if (outcome.detail !== undefined) {
            await this.#repo.markFailed(row.id, outcome.error, outcome.detail);
          } else {
            await this.#repo.markFailed(row.id, outcome.error);
          }
          stepResults.push({ step, status: 'failed', message: outcome.error });
          await this.#audit(domain, `step_${step}_failed`, source, { error: outcome.error });
          logger.error(
            { domain, step, error: outcome.error },
            'PostAcquisitionService: step failed',
          );
          break;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await this.#repo.markFailed(row.id, message);
        stepResults.push({ step, status: 'failed', message });
        await this.#audit(domain, `step_${step}_failed`, source, { error: message });
        logger.error({ domain, step, err }, 'PostAcquisitionService: step threw');
        break;
      }
    }

    await this.#audit(domain, 'automation_run_finished', source, {
      steps: stepResults.map((s) => ({ step: s.step, status: s.status })),
    });

    return { domain, source, enabled: true, dryRun: effective.dryRun, steps: stepResults };
  }

  async getStatus(domain: string): Promise<PostAcquisitionStep[]> {
    return this.#repo.findByDomain(domain);
  }

  async listSteps(
    options: { status?: PostAcquisitionStepStatus; limit?: number } = {},
  ): Promise<PostAcquisitionStep[]> {
    return this.#repo.listRecent(options);
  }

  /** Re-run the whole pipeline for a domain (resets every step first). */
  async resetAndRun(
    domain: string,
    source: PostAcquisitionTriggerSource = 'manual',
  ): Promise<PostAcquisitionRunResult> {
    await this.#repo.resetDomain(domain);
    return this.run(domain, source);
  }

  /** Reset a single step so the next run executes it again. */
  async resetStep(domain: string, step: PostAcquisitionStepName): Promise<void> {
    await this.#repo.resetStep(domain, step);
  }

  async listAudit(limit: number = 100): Promise<AutomationAuditEntry[]> {
    return this.#auditRepo.listRecent(limit);
  }

  async #audit(
    domain: string,
    action: string,
    source: PostAcquisitionTriggerSource,
    detail?: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      await this.#auditRepo.insert({
        action,
        domain,
        actor: source,
        ...(detail !== undefined && detail !== null ? { detail } : {}),
      });
    } catch (err: unknown) {
      // Audit must never break the pipeline itself.
      logger.warn({ domain, action, err }, 'PostAcquisitionService: audit write failed');
    }
  }
}
