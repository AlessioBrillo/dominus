import { api } from './client.js';
import type { AccuracyReport } from '../types/domain.js';

export interface WeightSuggestion {
  current: Record<string, number>;
  suggested: Record<string, number>;
  delta: Record<string, number>;
  sampleSize: number;
}

export interface BacktestSnapshotResponse {
  rebuilt: boolean;
  outcomeCount: number;
  signalCount: number;
}

export interface BacktestReportResponse {
  sampleSize: number;
  accuracy: AccuracyReport;
  snapshotDate?: string;
}

export interface AutoTuneResponse {
  applied: boolean;
  dryRun: boolean;
  suggestion: WeightSuggestion;
}

export async function rebuildSnapshot(): Promise<BacktestSnapshotResponse> {
  return api.post<BacktestSnapshotResponse>('/backtest/snapshot');
}

export async function fetchBacktestReport(): Promise<BacktestReportResponse> {
  return api.post<BacktestReportResponse>('/backtest/report');
}

export async function suggestWeights(apply?: boolean): Promise<WeightSuggestion> {
  return api.post<WeightSuggestion>('/backtest/suggest-weights', { apply });
}

export async function runAutoTune(): Promise<AutoTuneResponse> {
  return api.post<AutoTuneResponse>('/backtest/auto-tune');
}
