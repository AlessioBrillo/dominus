export type JobType =
  | 'PIPELINE_RUN'
  | 'PORTFOLIO_RESCORE'
  | 'BACKTEST_BUILD'
  | 'BACKUP'
  | 'PRUNE'
  | 'WATCHLIST_POLL'
  | 'RENEWAL_CHECK';

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
}

export interface PortfolioRescoreResult {
  rescored: number;
  totalDurationMs: number;
  errors: Array<{ domain: string; error: string }>;
}

export interface BacktestBuildPayload {
  minSampleSize?: number;
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
}

export interface BackupResult {
  backupPath: string;
  sizeBytes: number;
  durationMs: number;
  prunedCount: number;
}

export interface PrunePayload {
  maxAgeDays?: number;
}

export interface PruneResult {
  deletedCandidates: number;
  deletedScoringRuns: number;
  deletedPipelineRuns: number;
  deletedProviderCache: number;
  deletedJobQueue: number;
}

export interface WatchlistPollPayload {}

export interface WatchlistPollResult {
  checked: number;
  available: number;
  notified: number;
  errors: number;
}

export interface RenewalCheckPayload {}

export interface RenewalCheckResult {
  alertsCreated: number;
  alertsAcknowledged: number;
  domainsChecked: number;
}

export type JobPayload =
  | PipelineRunPayload
  | PortfolioRescorePayload
  | BacktestBuildPayload
  | BackupPayload
  | PrunePayload
  | WatchlistPollPayload
  | RenewalCheckPayload;

export type JobResult =
  | PipelineRunResult
  | PortfolioRescoreResult
  | BacktestBuildResult
  | BackupResult
  | PruneResult
  | WatchlistPollResult
  | RenewalCheckResult;

export interface JobHandler<P extends JobPayload = JobPayload, R extends JobResult = JobResult> {
  jobType: JobType;
  handle(payload: P, signal?: AbortSignal): Promise<R>;
}
