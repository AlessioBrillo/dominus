/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import type {
  Listing,
  ListingOffer,
  NewListing,
  ListingUpdate,
  NewListingOffer,
  ListingsFilter,
} from '../../types/listing.js';
import { listingFromRow, listingOfferFromRow } from '../../types/listing.js';

export class ListingRepository {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  insert(listing: NewListing): { id: number } {
    const result = this.#db
      .prepare(
        `INSERT INTO listings (domain, marketplace, listing_url, price_eur, status, listed_at, expires_at, notes)
       VALUES (@domain, @marketplace, @listingUrl, @priceEur, @status, @listedAt, @expiresAt, @notes)`,
      )
      .run({
        domain: listing.domain,
        marketplace: listing.marketplace,
        listingUrl: listing.listingUrl,
        priceEur: listing.priceEur,
        status: listing.status,
        listedAt: listing.listedAt,
        expiresAt: listing.expiresAt,
        notes: listing.notes,
      });
    return { id: result.lastInsertRowid as number };
  }

  update(id: number, update: ListingUpdate): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (update.priceEur !== undefined) {
      sets.push('price_eur = @priceEur');
      params.priceEur = update.priceEur;
    }
    if (update.status !== undefined) {
      sets.push('status = @status');
      params.status = update.status;
    }
    if (update.listingUrl !== undefined) {
      sets.push('listing_url = @listingUrl');
      params.listingUrl = update.listingUrl;
    }
    if (update.expiresAt !== undefined) {
      sets.push('expires_at = @expiresAt');
      params.expiresAt = update.expiresAt;
    }
    if (update.notes !== undefined) {
      sets.push('notes = @notes');
      params.notes = update.notes;
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    this.#db.prepare(`UPDATE listings SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  delete(id: number): void {
    this.#db.prepare('DELETE FROM listings WHERE id = ?').run(id);
  }

  findById(id: number): Listing | undefined {
    const row = this.#db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as any;
    return row ? listingFromRow(row) : undefined;
  }

  findByDomain(domain: string): Listing[] {
    const rows = this.#db.prepare('SELECT * FROM listings WHERE domain = ?').all(domain) as any[];
    return rows.map(listingFromRow);
  }

  findByDomainAndMarketplace(domain: string, marketplace: string): Listing | undefined {
    const row = this.#db
      .prepare('SELECT * FROM listings WHERE domain = ? AND marketplace = ?')
      .get(domain, marketplace) as any;
    return row ? listingFromRow(row) : undefined;
  }

  findAll(filter?: ListingsFilter): Listing[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.marketplace) {
      conditions.push('marketplace = ?');
      params.push(filter.marketplace);
    }
    if (filter?.domain) {
      conditions.push('domain LIKE ?');
      params.push(`%${filter.domain}%`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM listings${where} ORDER BY created_at DESC`)
      .all(...params) as any[];
    return rows.map(listingFromRow);
  }

  findByStatus(status: string): Listing[] {
    const rows = this.#db
      .prepare('SELECT * FROM listings WHERE status = ? ORDER BY created_at DESC')
      .all(status) as any[];
    return rows.map(listingFromRow);
  }

  insertOffer(offer: NewListingOffer): { id: number } {
    const result = this.#db
      .prepare(
        `INSERT INTO listing_offers (listing_id, amount_eur, buyer, status, notes)
       VALUES (@listingId, @amountEur, @buyer, 'pending', @notes)`,
      )
      .run(offer);
    return { id: result.lastInsertRowid as number };
  }

  findOffersByListingId(listingId: number): ListingOffer[] {
    const rows = this.#db
      .prepare('SELECT * FROM listing_offers WHERE listing_id = ? ORDER BY received_at DESC')
      .all(listingId) as any[];
    return rows.map(listingOfferFromRow);
  }

  findPendingOffer(listingId: number): ListingOffer | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM listing_offers WHERE listing_id = ? AND status = 'pending' ORDER BY received_at DESC LIMIT 1",
      )
      .get(listingId) as any;
    return row ? listingOfferFromRow(row) : undefined;
  }

  updateOfferStatus(id: number, status: string, notes?: string): void {
    this.#db
      .prepare(
        "UPDATE listing_offers SET status = @status, responded_at = datetime('now'), notes = COALESCE(@notes, notes) WHERE id = @id",
      )
      .run({ id, status, notes: notes ?? null });
  }
}
