import type { DatabaseProvider } from '../provider/interface.js';
import { BidStatus, type Bid, type PlaceBidInput } from '../../types/acquisition.js';

interface BidRow {
  id: number;
  domain: string;
  venue: string;
  bid_amount_eur: number;
  max_bid_eur: number | null;
  status: string;
  won_price_eur: number | null;
  expected_value_at_bid: number | null;
  confidence_at_bid: number | null;
  suggested_buy_max_at_bid: number | null;
  trademark_clear_at_bid: number | null;
  bid_placed_at: string;
  auction_ends_at: string | null;
  resolved_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToBid(row: BidRow): Bid {
  return {
    id: row.id,
    domain: row.domain,
    venue: row.venue,
    bidAmountEur: row.bid_amount_eur,
    maxBidEur: row.max_bid_eur ?? undefined,
    status: row.status as BidStatus,
    wonPriceEur: row.won_price_eur ?? undefined,
    expectedValueAtBid: row.expected_value_at_bid ?? undefined,
    confidenceAtBid: row.confidence_at_bid ?? undefined,
    suggestedBuyMaxAtBid: row.suggested_buy_max_at_bid ?? undefined,
    trademarkClearAtBid:
      row.trademark_clear_at_bid === 1
        ? true
        : row.trademark_clear_at_bid === 0
          ? false
          : undefined,
    bidPlacedAt: row.bid_placed_at,
    auctionEndsAt: row.auction_ends_at ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AcquisitionRepository {
  constructor(private readonly db: DatabaseProvider) {}

  insert(input: PlaceBidInput): Bid {
    const result = this.db.exec(
      `INSERT INTO bids
       (domain, venue, bid_amount_eur, max_bid_eur, status,
        expected_value_at_bid, confidence_at_bid,
        suggested_buy_max_at_bid, trademark_clear_at_bid,
        auction_ends_at, notes)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [
        input.domain,
        input.venue,
        input.bidAmountEur,
        input.maxBidEur ?? null,
        input.expectedValueAtBid ?? null,
        input.confidenceAtBid ?? null,
        input.suggestedBuyMaxAtBid ?? null,
        input.trademarkClearAtBid === undefined ? null : input.trademarkClearAtBid ? 1 : 0,
        input.auctionEndsAt ?? null,
        input.notes ?? null,
      ],
    );
    const id = result.lastInsertRowid as number;
    const row = this.db.queryOne<BidRow>('SELECT * FROM bids WHERE id = ?', [id]);
    return rowToBid(row!);
  }

  findPending(): Bid[] {
    const rows = this.db.query<BidRow>(
      'SELECT * FROM bids WHERE status = ? ORDER BY bid_placed_at ASC',
      [BidStatus.Pending],
    );
    return rows.map(rowToBid);
  }

  findByDomain(domain: string): Bid | null {
    const row = this.db.queryOne<BidRow>(
      'SELECT * FROM bids WHERE domain = ? ORDER BY bid_placed_at DESC LIMIT 1',
      [domain],
    );
    return row ? rowToBid(row) : null;
  }

  findByStatus(status: BidStatus): Bid[] {
    const rows = this.db.query<BidRow>(
      'SELECT * FROM bids WHERE status = ? ORDER BY bid_placed_at DESC',
      [status],
    );
    return rows.map(rowToBid);
  }

  findAll(): Bid[] {
    const rows = this.db.query<BidRow>('SELECT * FROM bids ORDER BY bid_placed_at DESC');
    return rows.map(rowToBid);
  }

  resolve(
    domain: string,
    status: BidStatus.Won | BidStatus.Lost | BidStatus.Cancelled | BidStatus.Outbid,
    wonPriceEur?: number,
    notes?: string,
  ): Bid | null {
    const existing = this.findByDomain(domain);
    if (existing === null) return null;

    this.db.exec(
      `UPDATE bids
       SET status = ?, won_price_eur = COALESCE(?, won_price_eur),
           resolved_at = datetime('now'), notes = COALESCE(?, notes),
           updated_at = datetime('now')
       WHERE id = ?`,
      [status, wonPriceEur ?? null, notes ?? null, existing.id],
    );

    return this.findByDomain(domain);
  }
}
