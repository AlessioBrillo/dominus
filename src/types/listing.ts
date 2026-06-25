export type ListingStatus =
  | 'draft'
  | 'listed'
  | 'offer_received'
  | 'sold'
  | 'expired'
  | 'unlisted'
  | 'pending'
  | 'paused';

export type MarketplaceName = 'dan' | 'afternic' | 'sedo' | 'godaddy' | 'manual';

export type OfferStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'countered'
  | 'expired'
  | 'withdrawn';

export interface ListingOffer {
  id: number;
  listingId: number;
  amountEur: number;
  buyer: string;
  status: OfferStatus;
  receivedAt: string;
  respondedAt: string | null;
  notes: string | null;
}

export interface NewListingOffer {
  listingId: number;
  amountEur: number;
  buyer: string;
  notes: string | null;
}

export interface Listing {
  id: number;
  domain: string;
  marketplace: MarketplaceName;
  listingUrl: string | null;
  priceEur: number;
  status: ListingStatus;
  scoringSnapshotJson: string | null;
  listedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewListing {
  domain: string;
  marketplace: MarketplaceName;
  priceEur: number;
  listingUrl: string | null;
  status: ListingStatus;
  listedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
}

export interface ListingUpdate {
  priceEur?: number;
  status?: ListingStatus;
  listingUrl?: string;
  expiresAt?: string;
  notes?: string;
}

export interface ListingsFilter {
  status?: ListingStatus;
  marketplace?: MarketplaceName;
  domain?: string;
}

export type AutoListSource = 'acquisition' | 'purchase' | 'pipeline_run' | 'manual';

export type AutoListStatus = 'active' | 'superseded' | 'cancelled';

export interface AutoListing {
  id: number;
  domain: string;
  portfolioEntryId: number | null;
  listingId: number;
  triggerSource: AutoListSource;
  pipelineRunId: string | null;
  scoreSnapshotJson: string | null;
  autoListedAt: string;
  status: AutoListStatus;
}

export interface NewAutoListing {
  domain: string;
  listingId: number;
  triggerSource: AutoListSource;
  pipelineRunId?: string | null;
  scoreSnapshotJson?: string | null;
}

export interface AutoListingRow {
  id: number;
  domain: string;
  portfolio_entry_id: number | null;
  listing_id: number;
  trigger_source: string;
  pipeline_run_id: string | null;
  score_snapshot_json: string | null;
  auto_listed_at: string;
  status: string;
}

export function autoListingFromRow(row: AutoListingRow): AutoListing {
  return {
    id: row.id,
    domain: row.domain,
    portfolioEntryId: row.portfolio_entry_id,
    listingId: row.listing_id,
    triggerSource: row.trigger_source as AutoListSource,
    pipelineRunId: row.pipeline_run_id,
    scoreSnapshotJson: row.score_snapshot_json,
    autoListedAt: row.auto_listed_at,
    status: row.status as AutoListStatus,
  };
}

export interface ListingRow {
  id: number;
  domain: string;
  marketplace: string;
  listing_url: string | null;
  price_eur: number;
  status: string;
  scoring_snapshot_json: string | null;
  listed_at: string | null;
  expires_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListingOfferRow {
  id: number;
  listing_id: number;
  amount_eur: number;
  buyer: string;
  status: string;
  received_at: string;
  responded_at: string | null;
  notes: string | null;
}

export function listingFromRow(row: ListingRow): Listing {
  return {
    id: row.id,
    domain: row.domain,
    marketplace: row.marketplace as MarketplaceName,
    listingUrl: row.listing_url,
    priceEur: row.price_eur,
    status: row.status as ListingStatus,
    scoringSnapshotJson: row.scoring_snapshot_json,
    listedAt: row.listed_at,
    expiresAt: row.expires_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listingOfferFromRow(row: ListingOfferRow): ListingOffer {
  return {
    id: row.id,
    listingId: row.listing_id,
    amountEur: row.amount_eur,
    buyer: row.buyer,
    status: row.status as OfferStatus,
    receivedAt: row.received_at,
    respondedAt: row.responded_at,
    notes: row.notes,
  };
}
