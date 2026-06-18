import type { Listing, ListingOffer, NewListing, ListingUpdate } from '../../types/listing.js';

export interface SyncResult {
  marketplace: string;
  listings: Listing[];
  offers: ListingOffer[];
  errors: string[];
  syncedAt: string;
}

export interface ListingProvider {
  readonly name: string;
  readonly isAvailable: boolean;

  createListing(listing: NewListing): Promise<Listing>;

  updateListing(id: string, update: ListingUpdate): Promise<Listing>;

  cancelListing(externalId: string): Promise<void>;

  getListing(externalId: string): Promise<Listing | undefined>;

  getListings(): Promise<Listing[]>;

  getOffers(externalId: string): Promise<ListingOffer[]>;

  sync(): Promise<SyncResult>;
}
