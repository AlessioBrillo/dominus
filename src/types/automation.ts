// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post-acquisition automation types (ADR-0083).
 *
 * The post-acquisition pipeline is the automated tail of the buy decision:
 * once a domain is acquired (registrar purchase, won auction, or manual
 * recording), the operator can let DOMINUS run the follow-up steps —
 * portfolio bookkeeping, landing page, indexing, DNS delegation,
 * parking/monetization and marketplace listing — without manual work.
 *
 * Every step is journaled in `post_acquisition_steps` (one row per
 * domain+step) so the pipeline is idempotent, resumable and auditable,
 * and every action is recorded in `automation_audit`. The whole pipeline
 * sits behind a kill switch (AUTOMATION_ENABLED, default off) and defaults
 * to dry-run (AUTOMATION_DRY_RUN, default on): steps that spend money or
 * mutate DNS must check the dry-run flag and skip instead.
 */

/** Ordered pipeline steps. The order is the execution order. */
export const POST_ACQUISITION_STEPS = [
  'portfolio',
  'site',
  'indexing',
  'dns',
  'parking',
  'listing',
] as const;

export type PostAcquisitionStepName = (typeof POST_ACQUISITION_STEPS)[number];

export type PostAcquisitionStepStatus = 'pending' | 'done' | 'skipped' | 'failed';

export type PostAcquisitionTriggerSource = 'purchase' | 'acquisition' | 'manual' | 'pipeline_run';

export interface PostAcquisitionStep {
  id: number;
  domain: string;
  step: PostAcquisitionStepName;
  status: PostAcquisitionStepStatus;
  attempts: number;
  source: PostAcquisitionTriggerSource;
  pipelineRunId: string | null;
  detailJson: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewPostAcquisitionStep {
  domain: string;
  step: PostAcquisitionStepName;
  source: PostAcquisitionTriggerSource;
  pipelineRunId?: string | null;
}

export interface PostAcquisitionStepRow {
  id: number;
  domain: string;
  step: string;
  status: string;
  attempts: number;
  source: string;
  pipeline_run_id: string | null;
  detail_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function postAcquisitionStepFromRow(row: PostAcquisitionStepRow): PostAcquisitionStep {
  return {
    id: row.id,
    domain: row.domain,
    step: row.step as PostAcquisitionStepName,
    status: row.status as PostAcquisitionStepStatus,
    attempts: row.attempts,
    source: row.source as PostAcquisitionTriggerSource,
    pipelineRunId: row.pipeline_run_id,
    detailJson: row.detail_json,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AutomationAuditEntry {
  id: number;
  action: string;
  domain: string | null;
  actor: string;
  detailJson: string | null;
  createdAt: string;
}

export interface NewAutomationAuditEntry {
  action: string;
  domain?: string | null;
  actor?: string;
  detail?: Record<string, unknown> | null;
}

export interface AutomationAuditRow {
  id: number;
  action: string;
  domain: string | null;
  actor: string;
  detail_json: string | null;
  created_at: string;
}

export function automationAuditFromRow(row: AutomationAuditRow): AutomationAuditEntry {
  return {
    id: row.id,
    action: row.action,
    domain: row.domain,
    actor: row.actor,
    detailJson: row.detail_json,
    createdAt: row.created_at,
  };
}

const STEP_NAMES: readonly string[] = POST_ACQUISITION_STEPS;
const STEP_STATUSES: readonly string[] = ['pending', 'done', 'skipped', 'failed'];
const TRIGGER_SOURCES: readonly string[] = ['purchase', 'acquisition', 'manual', 'pipeline_run'];

export function isPostAcquisitionStepName(value: string): value is PostAcquisitionStepName {
  return STEP_NAMES.includes(value);
}

export function isPostAcquisitionStepStatus(value: string): value is PostAcquisitionStepStatus {
  return STEP_STATUSES.includes(value);
}

export function isPostAcquisitionTriggerSource(
  value: string,
): value is PostAcquisitionTriggerSource {
  return TRIGGER_SOURCES.includes(value);
}

/** Result of one pipeline execution, one entry per step in POST_ACQUISITION_STEPS order. */
export interface PostAcquisitionRunStepResult {
  step: PostAcquisitionStepName;
  status: PostAcquisitionStepStatus;
  message?: string;
}

export interface PostAcquisitionRunResult {
  domain: string;
  source: PostAcquisitionTriggerSource;
  /** False when the run was refused because the kill switch is off. */
  enabled: boolean;
  dryRun: boolean;
  steps: PostAcquisitionRunStepResult[];
}

export interface AutomationSettings {
  enabled: boolean;
  dryRun: boolean;
}
