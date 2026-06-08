import type { DomainStatus } from './domain-status.js';

export interface WatchlistEntry {
  id: number;
  domain: string;
  tld: string;
  notes: string | null;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  lastStatusChange: string | null;
  notified: number;
  createdAt: string;
  updatedAt: string;
}

export interface InsertWatchlistInput {
  domain: string;
  tld: string;
  notes?: string | undefined;
}

export interface UpdateWatchlistStatusInput {
  lastCheckedAt: string;
  lastStatus: DomainStatus;
  lastStatusChange: string | null;
  notified?: number | undefined;
}

export interface WatchlistPollResult {
  checked: number;
  available: number;
  notified: number;
  errors: number;
}
