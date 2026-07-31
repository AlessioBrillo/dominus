import type { DatabaseProvider } from '../provider/interface.js';

export interface WebhookEventRow {
  id: number;
  provider: string;
  event_id: string;
  event_type: string;
  processed_at: string;
}

/**
 * Durable at-least-once webhook deduplication store.
 *
 * External webhooks (Stripe) deliver events at-least-once and may re-deliver
 * the same event across process restarts and across multiple API replicas.
 * Recording the event id here — atomically, with a unique constraint — makes
 * processing idempotent process-wide and deployment-wide.
 */
export class WebhookEventsRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  /**
   * Atomically record an event as processed.
   * Returns `true` when the event was newly recorded (must be processed),
   * `false` when it was already seen (duplicate — must be skipped).
   */
  async markProcessed(provider: string, eventId: string, eventType: string): Promise<boolean> {
    const result = await this.#db.exec(
      `INSERT INTO webhook_events (provider, event_id, event_type)
       VALUES (?, ?, ?)
       ON CONFLICT(provider, event_id) DO NOTHING`,
      [provider, eventId, eventType],
    );
    return result.changes > 0;
  }

  /** True when the event id was already recorded (dedup check without inserting). */
  async isProcessed(provider: string, eventId: string): Promise<boolean> {
    const row = await this.#db.queryOne<{ id: number }>(
      'SELECT id FROM webhook_events WHERE provider = ? AND event_id = ?',
      [provider, eventId],
    );
    return row !== null;
  }

  /** Remove processed-event rows older than the retention cutoff. */
  async pruneOlderThan(cutoff: string): Promise<number> {
    const result = await this.#db.exec('DELETE FROM webhook_events WHERE processed_at < ?', [
      cutoff,
    ]);
    return result.changes;
  }
}
