# ADR-0071: Sedo Listing Provider and Sell-Side Correctness Fixes

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-09-07 |
| **Authors** | Alessio Brillo |
| **Deciders** | Alessio Brillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0004, ADR-0006, ADR-0070 |
| **Project** | DOMINUS |

## Context

ADR-0070 unlocked Afternic behind the single-active-provider switch and
closed the trademark-gate bypass on the publish path. Three sell-side
defects remained:

1. `sedo` (and `godaddy`) are accepted by the `MarketplaceName` type, the
   `0024_create_listings` CHECK constraint, `LISTING_DEFAULT_MARKETPLACE`
   and the listings API allow-list — but no provider implements them, so a
   `sedo` draft published through the active Dan/Afternic provider was
   silently misrouted to the wrong marketplace.
2. `ManualListingProvider.isAvailable` is always `true`, so
   `ListingManager.listOnMarketplace()` took the remote branch and called
   `createListing()` → fresh `INSERT` → `UNIQUE(domain, marketplace)`
   violation → the draft was stuck at `pending`.
3. All three HTTP adapters looped `while (all.length < total)` with no page
   cap (infinite loop when `total` grows) and used bare `parseInt()` on
   remote string ids (`sd-1001` → `NaN`), silently breaking the sync
   offer linkage.

## Decision Drivers

1. **Provider abstraction (ADR-0004)** — a new marketplace is one adapter
   file plus factory/config wiring; zero core-logic changes.
2. **Trademark gate is non-negotiable (ADR-0006)** — unchanged; the new
   adapter reuses the existing pre-insert/pre-publish checks.
3. **Fail loudly, never misroute** — a marketplace label that does not
   match the active provider must be a visible 400, not a silent publish
   elsewhere.
4. **Zero-cost discipline** — no new dependencies; `fetch` + existing
   retry/error types only.

## Considered Options

### Option A: Sedo adapter + publish-path guards, single active provider (Chosen)

- New `SedoListingProvider` mirrors `AfternicListingProvider` (Bearer
  auth, paginated sync, status maps). `LISTING_PROVIDER` gains `sedo`;
  `SEDO_API_KEY` / `SEDO_API_URL` added. Without a key
  `isAvailable=false` and the manager degrades to local tracking,
  identical to Dan/Afternic semantics. Remote schema is adapter-shaped
  (refined against live credentials later), same caveat as ADR-0070.
- Shared `remote-id.ts`: `safeRemoteNumericId()` (numeric ids stable,
  string ids → deterministic hash, never NaN) and `MAX_SYNC_PAGES = 50`
  adopted by all three HTTP adapters; truncation surfaces as a sync
  error string plus a warn log.
- `ListingManager.listOnMarketplace()`: the local-only path triggers on
  `provider.name === 'manual'` (not `isAvailable`), fixing the
  UNIQUE-violation stuck-pending bug; a draft whose marketplace differs
  from the active non-manual provider throws `LISTING_MARKETPLACE_MISMATCH`
  (mapped to HTTP 400 on `POST /:id/publish`).
- `recordOffer()` rejects non-finite/`<= 0` amounts (defense in depth;
  the API route already validates).

**Disadvantages:** no parallel Dan+Afternic+Sedo listing (same single-
provider trade-off as ADR-0070); `godaddy` remains label-only.

### Option B: Multi-marketplace fan-out registry

Publish one domain to several marketplaces in parallel.

**Rejected:** same rejection as ADR-0070 Opt.B — registry, conflict
resolution and offer deduplication for unmeasured sell-through. Revisit
when Sedo measures incremental distribution.

### Option C: Sedo adapter without the correctness fixes

Ship the adapter, fix manual/mismatch/pagination later.

**Rejected:** ships two known silent-corruption paths (misrouting,
stuck-pending) on a wider marketplace surface.

## Decision Outcome

**Chosen: Option A.** Implementation:

- `src/providers/listing/sedo-listing-provider.ts` — new adapter.
- `src/providers/listing/remote-id.ts` — shared id/page-cap helpers.
- `src/providers/listing/dan-listing-provider.ts`,
  `src/providers/listing/afternic-listing-provider.ts` — adopt the
  shared helpers (no behavior change on happy paths).
- `src/providers/listing/index.ts`, `src/config.ts`,
  `src/app/composition-root.ts`, `.env.example` — wiring + docs.
- `src/listing/listing-manager.ts` — manual local path, mismatch guard,
  offer amount guard.
- `src/api/routes/listings.ts` — `LISTING_MARKETPLACE_MISMATCH` → 400.

## Consequences

### Positive

- Sedo distribution unlocked behind one env switch with graceful
  manual-mode degrade.
- No draft can publish to the wrong marketplace silently; manual publish
  no longer hits the UNIQUE constraint.
- Sync pagination is bounded on every HTTP adapter; string remote ids
  no longer produce NaN linkage.

### Negative

- `godaddy` is still label-only (same silent-label situation Sedo just
  left; publish guard now converts it to a loud 400).
- Sedo remote schema is adapter-shaped until verified against live
  credentials (same caveat as Afternic in ADR-0070).
- Truncation at the 50-page cap needs a re-run to continue (surfaced in
  sync errors; acceptable for a manual/scheduled sync).

### Compliance and Security Implications

- No new secrets beyond the existing `*_API_KEY` env pattern; keys stay
  in memory, never logged.
- Trademark-gate enforcement points unchanged (pre-insert, pre-publish,
  sync mirror).

### Migration and Monitoring Plan

- Rollout: `LISTING_PROVIDER=sedo` + `SEDO_API_KEY`; rollback to
  `manual` is env-only.
- Watch: `LISTING_MARKETPLACE_MISMATCH` 400 rate (mislabelled drafts),
  `pagination truncated` sync errors, Sedo `sync()` error strings.

### Validation

- Unit: `sedo-listing-provider.test.ts` (auth, mapping, string ids,
  pagination cap, factory wiring); `listing-manager.test.ts` (manual
  publish, mismatch, invalid amounts); `listings.test.ts` (400 mapping).
- Gate: `npm run typecheck`, `npm run lint`, listing test suites.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*
