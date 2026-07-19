import { api } from './client.js';
import type { PipelineRun, Candidate } from '../types/domain.js';

export interface RunListResponse {
  runs: PipelineRun[];
}

export interface RunDetailResponse extends PipelineRun {
  candidates?: Candidate[];
}

export interface SubmitRunRequest {
  keywords?: string[];
  brandableNames?: string[];
  closeoutDomains?: string[];
  closeoutCsv?: string;
  sync?: boolean;
}

export interface SubmitRunResponse {
  runId: string;
  jobId?: string;
}

export async function fetchRuns(since?: string, limit?: number): Promise<PipelineRun[]> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const data = await api.get<RunListResponse>(`/runs${qs ? `?${qs}` : ''}`);
  return data.runs;
}

export async function fetchRun(runId: string): Promise<RunDetailResponse> {
  return api.get<RunDetailResponse>(`/runs/${encodeURIComponent(runId)}`);
}

export async function submitRun(input: SubmitRunRequest): Promise<SubmitRunResponse> {
  return api.post<SubmitRunResponse>('/runs', input);
}

export async function deleteRun(runId: string): Promise<void> {
  await api.delete(`/runs/${encodeURIComponent(runId)}`);
}

export async function pruneRuns(dryRun?: boolean): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/runs/prune', { dryRun });
}
