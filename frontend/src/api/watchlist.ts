import { api } from './client.js';

export interface WatchlistEntry {
  domain: string;
  addedAt: string;
  lastPolledAt?: string;
  isAvailable?: boolean;
  notes?: string;
}

export interface WatchlistListResponse {
  entries: WatchlistEntry[];
}

export async function fetchWatchlist(): Promise<WatchlistEntry[]> {
  const data = await api.get<WatchlistListResponse>('/watchlist');
  return data.entries;
}

export async function addToWatchlist(domain: string, notes?: string): Promise<WatchlistEntry> {
  return api.post<WatchlistEntry>('/watchlist', { domain, notes });
}

export async function removeFromWatchlist(domain: string): Promise<void> {
  await api.delete(`/watchlist/${encodeURIComponent(domain)}`);
}

export async function pollWatchlist(): Promise<{ checked: number; changed: number }> {
  return api.post<{ checked: number; changed: number }>('/watchlist/poll');
}
