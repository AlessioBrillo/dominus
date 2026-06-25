import { api } from './client.js';
import type { Listing, ListingOffer } from '../types/domain.js';

export interface CreateListingRequest {
  domain: string;
  marketplace?: string;
  price?: number;
}

export interface UpdateListingRequest {
  priceEur?: number;
  status?: string;
  notes?: string;
}

export interface RecordOfferRequest {
  amount: number;
  buyer: string;
  notes?: string;
}

export function listListings(
  status?: string,
  marketplace?: string,
  domain?: string,
): Promise<{ listings: Listing[] }> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (marketplace) params.set('marketplace', marketplace);
  if (domain) params.set('domain', domain);
  const query = params.toString() ? `?${params.toString()}` : '';
  return api.get<{ listings: Listing[] }>(`/listings${query}`);
}

export function getListing(id: number): Promise<{ listing: Listing; offers: ListingOffer[] }> {
  return api.get<{ listing: Listing; offers: ListingOffer[] }>(`/listings/${id}`);
}

export function createListing(input: CreateListingRequest): Promise<{ listing: Listing }> {
  return api.post<{ listing: Listing }>('/listings', input);
}

export function updateListing(
  id: number,
  input: UpdateListingRequest,
): Promise<{ listing: Listing }> {
  return api.patch<{ listing: Listing }>(`/listings/${id}`, input);
}

export function deleteListing(id: number): Promise<void> {
  return api.delete<void>(`/listings/${id}`);
}

export function publishListing(id: number): Promise<{ listing: Listing }> {
  return api.post<{ listing: Listing }>(`/listings/${id}/publish`);
}

export function syncListings(): Promise<{
  listings: Listing[];
  offers: ListingOffer[];
  errors: string[];
}> {
  return api.post<{ listings: Listing[]; offers: ListingOffer[]; errors: string[] }>(
    '/listings/sync',
  );
}

export function listOffers(listingId: number): Promise<{ offers: ListingOffer[] }> {
  return api.get<{ offers: ListingOffer[] }>(`/listings/${listingId}/offers`);
}

export function recordOffer(
  listingId: number,
  input: RecordOfferRequest,
): Promise<{ offer: ListingOffer }> {
  return api.post<{ offer: ListingOffer }>(`/listings/${listingId}/offers`, input);
}

export function acceptOffer(listingId: number, offerId: number): Promise<{ status: string }> {
  return api.post<{ status: string }>(`/listings/${listingId}/offers/${offerId}/accept`);
}

export function declineOffer(listingId: number, offerId: number): Promise<{ status: string }> {
  return api.post<{ status: string }>(`/listings/${listingId}/offers/${offerId}/decline`);
}
