/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DatabaseProvider } from '../provider/interface.js';
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
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async insert(listing: NewListing): Promise<{ id: number }> {
    const result = await this.#db.exec(
      `INSERT INTO listings (domain, marketplace, listing_url, price_eur, status, listed_at, expires_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        listing.domain,
        listing.marketplace,
        listing.listingUrl,
        listing.priceEur,
        listing.status,
        listing.listedAt,
        listing.expiresAt,
        listing.notes,
      ],
    );
    return { id: result.lastInsertRowid as number };
  }

  async update(id: number, update: ListingUpdate): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (update.priceEur !== undefined) {
      sets.push('price_eur = ?');
      params.push(update.priceEur);
    }
    if (update.status !== undefined) {
      sets.push('status = ?');
      params.push(update.status);
    }
    if (update.listingUrl !== undefined) {
      sets.push('listing_url = ?');
      params.push(update.listingUrl);
    }
    if (update.expiresAt !== undefined) {
      sets.push('expires_at = ?');
      params.push(update.expiresAt);
    }
    if (update.notes !== undefined) {
      sets.push('notes = ?');
      params.push(update.notes);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    params.push(id);
    await this.#db.exec(`UPDATE listings SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async delete(id: number): Promise<void> {
    await this.#db.exec('DELETE FROM listings WHERE id = ?', [id]);
  }

  async findById(id: number): Promise<Listing | undefined> {
    const row = await this.#db.queryOne<any>('SELECT * FROM listings WHERE id = ?', [id]);
    return row ? listingFromRow(row) : undefined;
  }

  async findByDomain(domain: string): Promise<Listing[]> {
    const rows = await this.#db.query<any>('SELECT * FROM listings WHERE domain = ?', [domain]);
    return rows.map(listingFromRow);
  }

  async findByDomainAndMarketplace(
    domain: string,
    marketplace: string,
  ): Promise<Listing | undefined> {
    const row = await this.#db.queryOne<any>(
      'SELECT * FROM listings WHERE domain = ? AND marketplace = ?',
      [domain, marketplace],
    );
    return row ? listingFromRow(row) : undefined;
  }

  async findAll(filter?: ListingsFilter): Promise<Listing[]> {
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
    const rows = await this.#db.query<any>(
      `SELECT * FROM listings${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(listingFromRow);
  }

  async findByStatus(status: string): Promise<Listing[]> {
    const rows = await this.#db.query<any>(
      'SELECT * FROM listings WHERE status = ? ORDER BY created_at DESC',
      [status],
    );
    return rows.map(listingFromRow);
  }

  async insertOffer(offer: NewListingOffer): Promise<{ id: number }> {
    const result = await this.#db.exec(
      `INSERT INTO listing_offers (listing_id, amount_eur, buyer, status, notes)
       VALUES (?, ?, ?, 'pending', ?)`,
      [offer.listingId, offer.amountEur, offer.buyer, offer.notes ?? null],
    );
    return { id: result.lastInsertRowid as number };
  }

  async findOffersByListingId(listingId: number): Promise<ListingOffer[]> {
    const rows = await this.#db.query<any>(
      'SELECT * FROM listing_offers WHERE listing_id = ? ORDER BY received_at DESC',
      [listingId],
    );
    return rows.map(listingOfferFromRow);
  }

  async findPendingOffer(listingId: number): Promise<ListingOffer | undefined> {
    const row = await this.#db.queryOne<any>(
      "SELECT * FROM listing_offers WHERE listing_id = ? AND status = 'pending' ORDER BY received_at DESC LIMIT 1",
      [listingId],
    );
    return row ? listingOfferFromRow(row) : undefined;
  }

  async updateOfferStatus(id: number, status: string, notes?: string): Promise<void> {
    await this.#db.exec(
      "UPDATE listing_offers SET status = ?, responded_at = datetime('now'), notes = COALESCE(?, notes) WHERE id = ?",
      [status, notes ?? null, id],
    );
  }
}
