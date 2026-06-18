import { api } from './client.js';
import type { PnlReport, AccuracyReport } from '../types/domain.js';

export function fetchPnlReport(): Promise<PnlReport> {
  return api.get<PnlReport>('/analytics/pnl');
}

export function refreshAccuracy(): Promise<{ scanned: number; included: number }> {
  return api.post<{ scanned: number; included: number }>('/analytics/refresh');
}

export function fetchAccuracyReport(): Promise<AccuracyReport> {
  return api.get<AccuracyReport>('/analytics/accuracy');
}
