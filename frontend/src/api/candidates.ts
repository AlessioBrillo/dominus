import { api } from './client.js';
import type { Candidate } from '../types/domain.js';

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

export function fetchCandidates(runId: string): Promise<CandidateListResponse> {
  return api.get<CandidateListResponse>(`/api/candidates?runId=${encodeURIComponent(runId)}`);
}

export function runPipeline(input: RunPipelineRequest): Promise<RunPipelineResponse> {
  return api.post<RunPipelineResponse>('/api/candidates/run', input);
}
