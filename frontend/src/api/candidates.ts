import { api } from './client.js';
import type { Candidate, PipelineRun } from '../types/domain.js';

export interface CandidateListResponse {
  candidates: Candidate[];
}

export interface RunPipelineRequest {
  keywords?: string[];
  brandableNames?: string[];
  closeoutDomains?: string[];
}

export interface RunPipelineResponse {
  runId: string;
  recommended: Candidate[];
  stageSummary: Record<string, { passed: number; filtered: number; durationMs: number }>;
  totalDurationMs: number;
}

export async function fetchCandidates(runId?: string): Promise<Candidate[]> {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  const data = await api.get<CandidateListResponse>(`/candidates${query}`);
  return data.candidates;
}

export async function runPipeline(input: RunPipelineRequest): Promise<RunPipelineResponse> {
  return api.post<RunPipelineResponse>('/candidates/run', input);
}

export async function deleteCandidate(domain: string): Promise<void> {
  await api.delete(`/candidates/${encodeURIComponent(domain)}`);
}

export async function fetchRuns(): Promise<PipelineRun[]> {
  const data = await api.get<{ runs: PipelineRun[] }>('/runs');
  return data.runs;
}
