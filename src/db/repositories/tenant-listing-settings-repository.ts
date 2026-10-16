// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type {
  TenantListingSettings,
  TenantListingSettingsRow,
  TenantListingSettingsUpdate,
} from '../../types/listing-settings.js';
import {
  DEFAULT_TENANT_LISTING_SETTINGS,
  tenantListingSettingsFromRow,
} from '../../types/listing-settings.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

/**
 * Per-tenant listing policy (ADR-0083, M4).
 *
 * One row per tenant, created on first write; before that the
 * conservative defaults apply (scoring price, no automatic offer
 * answers). Every query filters on the resolved tenant id.
 */
export class TenantListingSettingsRepository {
  constructor(private readonly db: DatabaseProvider) {}

  /** Current tenant listing settings, or the conservative defaults. */
  async get(): Promise<TenantListingSettings> {
    const row = await this.db.queryOne<TenantListingSettingsRow>(
      `SELECT tenant_id, price_policy, base_price_eur, offer_auto_decline_below_eur,
              offer_counter_eur, updated_at
         FROM tenant_listing_settings WHERE tenant_id = ?`,
      [resolveTenantId()],
    );
    return row ? tenantListingSettingsFromRow(row) : { ...DEFAULT_TENANT_LISTING_SETTINGS };
  }

  /** Merge a partial update into the current settings and persist the result. */
  async set(update: TenantListingSettingsUpdate): Promise<TenantListingSettings> {
    const current = await this.get();
    const next: TenantListingSettings = {
      pricePolicy: update.pricePolicy ?? current.pricePolicy,
      basePriceEur: update.basePriceEur !== undefined ? update.basePriceEur : current.basePriceEur,
      offerAutoDeclineBelowEur:
        update.offerAutoDeclineBelowEur !== undefined
          ? update.offerAutoDeclineBelowEur
          : current.offerAutoDeclineBelowEur,
      offerCounterEur:
        update.offerCounterEur !== undefined ? update.offerCounterEur : current.offerCounterEur,
    };

    await this.db.exec(
      `INSERT INTO tenant_listing_settings
         (tenant_id, price_policy, base_price_eur, offer_auto_decline_below_eur,
          offer_counter_eur, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (tenant_id) DO UPDATE SET
         price_policy = excluded.price_policy,
         base_price_eur = excluded.base_price_eur,
         offer_auto_decline_below_eur = excluded.offer_auto_decline_below_eur,
         offer_counter_eur = excluded.offer_counter_eur,
         updated_at = CURRENT_TIMESTAMP`,
      [
        resolveTenantId(),
        next.pricePolicy,
        next.basePriceEur,
        next.offerAutoDeclineBelowEur,
        next.offerCounterEur,
      ],
    );

    return next;
  }
}
