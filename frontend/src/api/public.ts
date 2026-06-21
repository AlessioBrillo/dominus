import { api } from './client';

export interface PublicScoreResponse {
  slug: string;
  domain: string;
  score: {
    domain: string;
    expectedValue: number;
    confidence: number;
    suggestedBuyMax: number;
    suggestedListPrice: number;
    weightedScore: number;
    recommended: boolean;
    scoredAt: string;
    breakdown: {
      intrinsic: { score: number; weight: number };
      commercial: { score: number; weight: number };
      market: { score: number; weight: number };
      expiry: { score: number; weight: number };
    };
  };
  trademark: {
    verdict: string;
    verifiedSources: string[];
    matchedMark?: string | null;
  } | null;
  viewCount: number;
  createdAt: string;
}

export interface ShareScoreResponse {
  slug: string;
  url: string;
  domain: string;
}

export function shareScore(domain: string): Promise<ShareScoreResponse> {
  return api.post<ShareScoreResponse>('/public/scores', { domain });
}

export function getPublicScore(slug: string): Promise<PublicScoreResponse> {
  return api.get<PublicScoreResponse>(`/public/s/${slug}`);
}
