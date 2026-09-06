# ADR-0070: Afternic Listing Provider and Trademark-Gated Publishing

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-09-06 |
| **Authors** | Alessio Brillo |
| **Deciders** | Alessio Brillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0004, ADR-0006, ADR-0012 |
| **Project** | DOMINUS |

## Context

The sell side supports five marketplaces in the type system
(`MarketplaceName`: `dan | afternic | sedo | godaddy | manual`) and the
`0024_create_listings` CHECK constraint, but only `manual` and `dan`
have `ListingProvider` implementations. `LISTING_PROVIDER` rejects
`afternic` at config validation, so the largest distribution network
(GoDaddy/Afternic Fast Transfer) is unreachable.

Separately, `ListingManager` received the `TrademarkGate` as an unused
`_trademarkGate` parameter and published without any trademark check:
a TM-blocked domain could reach `listed` on an external marketplace,
violating Principle 6 (ADR-0006). Any marketplace expansion before
closing this gap multiplies legal exposure.

## Decision Drivers

1. **Trademark gate is non-negotiable (ADR-0006)** — publishing is a
   legal-exposure point equal to the buy recommendation.
2. **Provider abstraction (ADR-0004)** — a new marketplace is one
   adapter file plus factory/config wiring; zero core-logic changes.
3. **Conservatism (ADR-0002)** — an `Unverified` gate must not publish
   externally, but destroying the local draft would lose tracking data.
4. **Zero-cost discipline** — no new dependencies; `fetch` + existing
   retry/error types only.

## Considered Options

### Option A: Trademark-gated Afternic adapter, single active provider (Chosen)

- `ListingManager.listDomain()` checks the gate before inserting:
  `Blocked` throws `TrademarkGateError` (no draft created);
  `Unverified` creates a local `draft` with a warning (local-only,
  no legal exposure).
- `ListingManager.listOnMarketplace()` re-checks at publish time
  (covers matches appearing after draft creation and pre-gate drafts):
  anything but `Clear` throws. Publish is the fail-closed point.
- New `AfternicListingProvider` mirrors `DanListingProvider` (Bearer
  auth, paginated sync, status maps). `LISTING_PROVIDER` gains
  `afternic`; `AFTERNIC_API_KEY` / `AFTERNIC_API_URL` added. Without a
  key `isAvailable=false` and the manager degrades to local tracking,
  identical to Dan semantics.
- Single active provider retained (`LISTING_PROVIDER` switch, no
  fan-out): one concern per branch, no registry/multi-publish semantics.

**Disadvantages:** no parallel Dan+Afternic listing; Afternic remote
schema is adapter-shaped (refined against live credentials later).

### Option B: Multi-marketplace fan-out registry

Publish one domain to Dan and Afternic in parallel with per-marketplace
status reconciliation.

**Rejected:** requires registry, conflict resolution (price/status
divergence), and offer deduplication — an order of magnitude more
surface for unmeasured sell-through. Revisit when Afternic measures
incremental distribution.

### Option C: Afternic without the gate fix

Ship the adapter first, gate later.

**Rejected:** ships the exact legal hazard identified in the context;
a blocked domain listable on two marketplaces instead of one.

## Decision Outcome

**Chosen: Option A.** Implementation:

- `src/listing/listing-manager.ts` — gate checks in `listDomain()`
  (pre-insert) and `listOnMarketplace()` (pre-publish).
- `src/providers/listing/afternic-listing-provider.ts` — new adapter.
- `src/providers/listing/index.ts`, `src/config.ts`,
  `src/app/composition-root.ts`, `.env.example` — wiring + docs.
- `AutoListingService` needs no change: gate throws are non-transient,
  surfaced as `skipped: error` with the trademark message.

## Consequences

### Positive

- No TM-blocked domain can be created or published through any path
  (manual, auto-list, pre-gate drafts).
- Afternic distribution unlocked behind one env switch with graceful
  manual-mode degrade.
- Dan `ProviderError` provider/code args corrected (`'dan'` provider,
  `DAN_API_*` codes) — error telemetry now groups by provider.

### Negative

- `Unverified` blocks external publish: during a USPTO/EUIPO outage,
  sell-side publishing stalls (drafts still tracked; pipeline-buy path
  already behaves this way per ADR-0012).
- Single-provider switch: operators wanting Dan+Afternic in parallel
  wait for the fan-out follow-up.

### Compliance and Security Implications

- Gate verdicts are fail-closed at both sell-side chokepoints; no
  secrets beyond the existing `*_API_KEY` env pattern.

### Migration and Monitoring Plan

- Rollout: `LISTING_PROVIDER=afternic` + `AFTERNIC_API_KEY`; rollback
  to `manual` is env-only.
- Watch: `TrademarkGateError` rate in auto-list skips; Afternic
  `sync()` error strings.

### Validation

- Unit: gate `Blocked`/`Unverified`/late-match tests in
  `listing-manager.test.ts`; full adapter tests in
  `afternic-listing-provider.test.ts` (mocked `fetch` boundary).
- Gate: `npm run typecheck`, `npm run lint`, listing test suites.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*
