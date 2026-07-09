export type JobType =
  | 'PIPELINE_RUN'
  | 'PORTFOLIO_RESCORE'
  | 'BACKTEST_BUILD'
  | 'BACKUP'
  | 'PRUNE'
  | 'WATCHLIST_POLL'
  | 'RENEWAL_CHECK'
  | 'WEIGHT_TUNE'
  | 'PORTFOLIO_HEALTHCHECK'
  | 'AUTO_LIST';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter';

export interface JobQueueRow {
  id: number;
  jobType: JobType;
  payloadJson: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  resultJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeadLetterJobRow {
  id: number;
  originalJobId: number;
  jobType: JobType;
  payloadJson: string;
  error: string;
  attempts: number;
  failedAt: string;
  originalCreatedAt: string;
}

export interface JobQueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  deadLetter: number;
  total: number;
}

import type { CandidateGenerationInput } from '../pipeline/stages/candidate-generation-stage.js';

export interface PipelineRunPayload {
  candidateGenerationInput: CandidateGenerationInput;
  runId: string;
  tenantId?: string;
}

export interface PipelineRunResult {
  runId: string;
  recommended: number;
  scored: number;
  totalDurationMs: number;
  stageErrors: string[];
}

export interface PortfolioRescorePayload {
  domain?: string;
  tenantId?: string;
}

export interface PortfolioRescoreResult {
  rescored: number;
  totalDurationMs: number;
  errors: Array<{ domain: string; error: string }>;
}

export interface BacktestBuildPayload {
  minSampleSize?: number;
  tenantId?: string;
}

export interface BacktestBuildResult {
  signalsBuilt: number;
  weightSuggestion?: {
    suggestedWeights: Record<string, number>;
    deltas: Record<string, number>;
    sampleSize: number;
  };
}

export interface BackupPayload {
  retentionDays?: number;
  tenantId?: string;
}

export interface BackupResult {
  backupPath: string;
  sizeBytes: number;
  durationMs: number;
  prunedCount: number;
}

export interface PrunePayload {
  maxAgeDays?: number;
  tenantId?: string;
}

export interface PruneResult {
  deletedCandidates: number;
  deletedScoringRuns: number;
  deletedPipelineRuns: number;
  deletedProviderCache: number;
  deletedJobQueue: number;
  deletedWaybackCache: number;
  deletedPublicScores: number;
  deletedEvents: number;
}

export interface WatchlistPollPayload {
  tenantId?: string;
}

export interface WatchlistPollResult {
  checked: number;
  available: number;
  notified: number;
  errors: number;
}

export interface RenewalCheckPayload {
  tenantId?: string;
}

export interface RenewalCheckResult {
  alertsCreated: number;
  alertsAcknowledged: number;
  domainsChecked: number;
}

export interface WeightTunePayload {
  tenantId?: string;
}

export interface PortfolioHealthcheckPayload {
  horizonDays?: number;
  batchSize?: number;
  tenantId?: string;
}

export interface PortfolioHealthcheckResult {
  checked: number;
  updated: number;
  errors: number;
}

export interface AutoListPayload {
  domains: Array<{ domain: string; scoreJson: string | null }>;
  pipelineRunId: string;
  source: string;
  tenantId?: string;
}

export interface AutoListResultData {
  listed: number;
  skipped: number;
  errors: number;
}

export interface WeightTuneResult {
  sampleSize: number;
  applied: boolean;
  safetyPassed: boolean;
  dryRun: boolean;
}

export type JobPayload =
  | PipelineRunPayload
  | PortfolioRescorePayload
  | BacktestBuildPayload
  | BackupPayload
  | PrunePayload
  | WatchlistPollPayload
  | RenewalCheckPayload
  | WeightTunePayload
  | PortfolioHealthcheckPayload
  | AutoListPayload;

export type JobResult =
  | PipelineRunResult
  | PortfolioRescoreResult
  | BacktestBuildResult
  | BackupResult
  | PruneResult
  | WatchlistPollResult
  | RenewalCheckResult
  | WeightTuneResult
  | PortfolioHealthcheckResult
  | AutoListResultData;

export interface JobHandler<P extends JobPayload = JobPayload, R extends JobResult = JobResult> {
  jobType: JobType;
  handle(payload: P, signal?: AbortSignal): Promise<R>;
}
