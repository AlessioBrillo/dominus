# ADR-0089: Tenant offer channel and exit — sale outcome closes the P&L loop

## Metadata

| Field          | Value                                                    |
| -------------- | -------------------------------------------------------- |
| **Status**     | Accepted                                                 |
| **Date**       | 2026-10-16                                               |
| **Authors**    | Alessio Brillo                                           |
| **Deciders**   | Alessio Brillo                                           |
| **Supersedes** | —                                                        |
| **Relates to** | ADR-0002, ADR-0004, ADR-0006, ADR-0082, ADR-0083, ADR-0084 |
| **Project**    | DOMINUS                                                  |

## Context

DOMINUS v1.2 already automates the path up to the listing: a bought domain gets a
for-sale page (`site` step, ADR-0083 M2), is delegated to a parking target
(`dns` step, M3), and can be listed via the `listing` step with tenant offer
rules (auto-decline floor / auto-counter, ADR-0083 M4). The `ListingManager`
already records incoming offers and lets the tenant accept/decline them.

What was missing to close the full lifecycle the user asked for — *from domain
purchase to exit* — is the **sale outcome**: when an offer is accepted the
system must record a `sold` outcome (sale price, commission, venue, acquisition
cost, renewal cost, days listed) so the P&L report realises the capital and the
portfolio stops treating the domain as a held asset. Without this, the exit is
invisible to P&L and the "guadagnci con una exit dopo un'asta" promise is not
honoured.

A public buyer-facing offer intake on the for-sale page completes the channel:
a visitor can submit an offer, which lands as a pending offer the tenant can
accept, counter or decline — all within the existing conservative offer-rule
framework, with the trademark gate still enforced at publish time (Principle 6).

## Decision Drivers

1. **Close the financial loop**: an accepted offer must produce a `sold`
   outcome with sale price, commission %, venue, acquisition cost, renewal
   cost and days listed, feeding `PnlService` so `netPnlEur`/`roiPct` are
   real, not estimated.
2. **No data loss**: a sold domain stays in the portfolio (its outcomes are
   append-only and the `outcomes` insert requires the domain to be present).
   The `sold` outcome is the source of truth that the domain exited.
3. **Tenant isolation**: the public offer intake writes to the listing's own
   tenant, never to a shared 'public' bucket. The listing's tenant is resolved
   from the domain (a listing is public content via the for-sale page, so the
   owning tenant is not secret).
4. **Trademark gate untouched**: publishing a listing still requires a
   `Clear` trademark verdict; offers can be received on unverified drafts but
   a sale only completes on a published, gate-cleared listing.
5. **ADR-0082 honesty**: no marketplace API adapter is introduced here; the
   exit channel is the tenant's own for-sale page + API, with vendor adapters
   (Afternic/Sedo/Dan) left out until verified.

## Considered Options

### Option A: Accepting an offer implicitly records a `sold` outcome

**Advantages:** zero new API surface; one action completes the sale.

**Disadvantages:** the accepted offer amount may differ from the final sale
price (fees, negotiation, payment terms); there is no place to capture
commission %, venue or actual proceeds. P&L would be inaccurate. Rejected.

### Option B: Dedicated sale-completion endpoint (chosen)

**Advantages:** the tenant confirms the actual sale price, commission, venue
and notes; a single `sold` outcome is recorded with full financials; the
listing and offer are both transitioned to `sold`/`accepted` atomically.

**Disadvantages:** one extra API call per sale. Acceptable.

### Option C: Public offer intake writes to a shared 'public' tenant

**Advantages:** simple, no tenant resolution needed.

**Disadvantages:** breaks tenant isolation — offers for tenant A's domain land
in tenant 'public' and are invisible to tenant A. Rejected.

## Decision

1. **`ListingManager.sellDomain(listingId, offerId, sale)`**: transitions the
   listing to `sold` and the offer to `accepted`, then inserts an `outcome`
   of type `sold` carrying `salePriceEur`, `listingPriceEur`, `daysListed`,
   `venue`, `commissionPct`, `acquisitionCostEur` and `totalRenewalCostEur`
   (the latter two read from the portfolio entry), plus `notes`. The sale is
   only allowed on a pending offer belonging to a `listed` listing.
2. **`POST /api/v1/listings/:listingId/offers/:offerId/sell`**: authenticated
   endpoint exposing `sellDomain`, with body `{ salePriceEur, commissionPct?,
   venue?, notes? }`. Requires `salePriceEur > 0`.
3. **Public offer intake `POST /public/for-sale/:domain/offer`**: unauthenticated,
   per-domain rate-limited, records a pending offer on the listing found by
   domain, executing under the listing's own tenant. Returns the created offer
   so the tenant can later accept/counter/decline via the authenticated API.
4. **`ListingRepository.getTenantForDomain(domain)`**: controlled read of the
   owning tenant id for public-intake routing only.
5. **No new migration**: the `outcomes` table (0006) already carries every
   column the `sold` outcome needs.
6. **OpenAPI + .env docs**: the new routes are documented; no new env vars.

## Consequences

**Positive:** the complete loop is honoured — purchase → listing → offer →
accepted sale → `sold` outcome → realised P&L → exit. The tenant sees the
real ROI per domain. The public for-sale page becomes a genuine buyer channel.

**Negative:** a sold domain remains in the portfolio table (historical
record); the renewal clock keeps ticking until the operator removes it
(`dominus portfolio remove`, already available). P&L counts its acquisition
and renewal costs against the sale — correct for realised P&L.

**Risk Assessment:** low. The `sold` outcome is insert-only; a mistaken sale
is corrected by a follow-up outcome (append-only model), never by mutation.

## Compliance Check

- [x] ADR-0002 conservatism: sale price is taken from the tenant-confirmed
  `sellDomain` payload, never invented.
- [x] ADR-0004 provider abstraction: no marketplace client; exit is via the
  tenant's own page + API.
- [x] ADR-0006 trademark gate: publishing still requires `Clear`; unaffected.
- [x] ADR-0038/0083 tenant isolation: public intake writes to the listing's
  tenant; every repository query is tenant-scoped.
- [x] ADR-0082 honesty: no unverified vendor adapter.
- [x] English identifiers and documentation throughout.
