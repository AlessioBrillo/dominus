import { api } from './client.js';
import type { ScoreResult } from '../types/domain.js';

export interface ScoreQuery {
  closeout?: boolean;
  age?: number;
  backlinks?: number;
  wayback?: number;
}

export interface ScoreResponse {
  domain: string;
  score: ScoreResult;
  trademark?: {
    verdict: string;
    verifiedSources: string[];
    matchedMark?: string;
    usptoFailed?: boolean;
    partial?: boolean;
  };
}

export function scoreDomain(domain: string, query?: ScoreQuery): Promise<ScoreResponse> {
  const params = new URLSearchParams();
  if (query?.closeout) params.set('closeout', 'true');
  if (query?.age !== undefined) params.set('age', String(query.age));
  if (query?.backlinks !== undefined) params.set('backlinks', String(query.backlinks));
  if (query?.wayback !== undefined) params.set('wayback', String(query.wayback));
  const qs = params.toString();
  return api.get<ScoreResponse>(`/api/score/${encodeURIComponent(domain)}${qs ? `?${qs}` : ''}`);
}
