# ADR-0014: EUIPO provider migration to Trademark Search 1.1.0 (RSQL + X-IBM-Client-Id)

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-07 |
| **Authors** | DOMINUS team |
| **Deciders** | DOMINUS team |
| **Supersedes** | N/A |
| **Relates to** | ADR-0012 (trademark matching policy), ADR-0013 (domain parsing consolidation, follow-up backlog), architecture-guardian §1 Principle 6 (trademark gate is non-negotiable) |
| **Project** | DOMINUS |

## Context

The trademark gate (ADR-0012) runs two free public providers in
sequence: USPTO for US jurisdiction and EUIPO for EU jurisdiction. A
gate that silently fails on one of them is worse than a gate that
fails loudly — the operator sees a "Clear" verdict and assumes the
buy recommendation is sound. The previous ADR fixed the detector
algorithm and added a strict-USPTO-TLD rule; the EUIPO source itself
was left untouched.

The EUIPO source has been silently broken since the underlying API
was retired. The `copla/trademark/data-capture/V1/trademarks`
endpoint returns 200 OK with an empty `trademarks` array for every
query. From the operator's vantage point, the EUIPO half of the gate
always returns zero hits, so:

- A `.io` or `.co` candidate with an EUIPO-registered mark but no
  USPTO match comes back **Clear** (only EUIPO was looked up; it
  returned nothing) instead of **Blocked**.
- The strict-USPTO-TLD rule does not catch this: a `.io` name does
  not trigger the `.com`/`.us` rule, so an EUIPO-only Clear is still
  accepted as a Clean verdict.

The new EUIPO API — "Trademark Search 1.1.0" — has been the only
live trademark search endpoint for some time. The wire format is
materially different from COPLA:

- The query parameter is `query`, not `trademarkName`, and the value
  is an RSQL expression (e.g. `trademarkName==*nike*`).
- The OAuth2 Bearer token must be accompanied by an
  `X-IBM-Client-Id` gateway header on every search request. The
  same `client_id` issued for OAuth2 is reused as the IBM
  identifier.
- The response envelope is Spring-Data style:
  `{ content: [...], totalElements, number, size }`.
- Status tokens changed: the legacy values ("Registered",
  "Refused", "Expired", "Withdrawn") are now uppercase ("REGISTERED",
  "REFUSED", "EXPIRED", "WITHDRAWN") and a few new values exist
  ("CANCELLED", "SURRENDERED", "APPLICATION_PUBLISHED", etc.).

The `TrademarkProvider` interface in
`src/providers/trademark/trademark-provider.ts` was designed to be
provider-agnostic (Principle 1). The migration touches only the
EUIPO adapter; the gate, the detector, and the upstream scoring
engine are not affected. This is exactly the resilience Principle 1
was meant to provide — and the reason a single commit can land the
fix without rippling through the codebase.

ADR-0013 already listed this migration as the second item in its
"Follow-up backlog" — the same pattern as the previous follow-up
(domain parsing, which became ADR-0013 itself). The work is not
gated on ADR-0013, but the timing is intentional: the SLD/TLD fix
corrects the *input* to the gate; this ADR corrects the *EUIPO
side* of the gate.

## Decision Drivers

1. **Principle 6 is non-negotiable** — every buy recommendation
   must rest on a non-bypassable trademark check. A gate that
   silently degrades to "EUIPO only returns 0 hits" is a
   sub-version of the same failure mode.
2. **EU jurisdiction coverage is the entire point of the EUIPO
   half of the gate.** A non-functional EUIPO provider is dead
   code; a single-provider (USPTO-only) gate is a regression from
   MVP.
3. **No paid API in MVP** (Principle 8) — the replacement must
   use the same free EUIPO subscription model (OAuth2
   client_credentials, free with identity verification).
4. **Wire format must be provider-agnostic at the gate level.**
   The change happens entirely inside `EuipoProvider`. The
   `TrademarkMatch` contract returned to the gate is unchanged.
5. **Defensive against RSQL injection** — the query string is
   built from a user-influenced term (the SLD). The provider must
   sanitise RSQL metacharacters before interpolating the term
   into the query.

## Considered Options

### Option A: Migrate to Trademark Search 1.1.0 (CHOSEN)

Update the EUIPO adapter to the new API contract: RSQL query via
`?query=trademarkName==*<term>*`, OAuth2 Bearer token plus
`X-IBM-Client-Id` header, paged response envelope, broadened
inactive-status filter.

**Advantages:**

- The EUIPO half of the gate becomes live again. Real EU
  marks are now surfaced, restoring cross-jurisdiction coverage.
- The change is scoped to one file (`euipo-provider.ts`); the
  provider-agnostic contract keeps the gate and the detector
  untouched.
- The `X-IBM-Client-Id` is the same identifier as the OAuth2
  `client_id`, so no new env var is needed; the operator only
  has to re-paste the same credential into the same env var.
- RSQL metacharacter sanitisation closes a small but real
  injection vector (`*`, `'`, `"`, `\\`, whitespace).
- The status filter broadens to cover `CANCELLED`,
  `SURRENDERED`, `INVALID`, `LAPSED`, `REVOKED` — the previous
  filter only excluded `REFUSED`, `WITHDRAWN`, `EXPIRED`.
- The 401/403 error message becomes actionable: it tells the
  operator to verify `EUIPO_CLIENT_ID` and the
  Trademark Search 1.1.0 subscription. The old message was
  terse and unhelpful.

**Disadvantages:**

- The EUIPO subscription must be active against the new API.
  EUIPO issues new credentials for the new endpoint; the
  operator has to re-register (free, 1-3 business days for
  identity verification). Out of scope for this code change;
  documented in the migration plan.
- The OAuth2 token URL is not part of the official spec
  documents surfaced by EUIPO. The default
  (`https://euipo.europa.eu/oauth2/token`) is a placeholder
  until a verified current URL is known; the operator can
  override it via `EUIPO_AUTH_URL`. This is a follow-up item
  with a documented env-var escape hatch.
- Pagination is not implemented. The first 50 hits are
  returned; if a search term produces more than 50 EU marks,
  the tail is silently dropped. At single-user scale with
  conservative `expected_value` thresholds, the operator
  rarely sees a TM search term with >50 active marks; a
  follow-up can iterate the `page` parameter when
  `totalElements > size`.

**Cost Implications:** Trivial. ~85 LOC of provider code +
~150 LOC of test fixtures. No new dependencies, no schema
migration, no DB change.

**Risk Assessment:** Low. The provider contract
(`TrademarkMatch[]`) is unchanged, so the gate's behaviour is
preserved when EUIPO returns the same hits it did before. The
only observable change is that EUIPO no longer returns zero
hits for every query, which is a strict improvement on the
"silent zero" failure mode.

---

### Option B: Drop EUIPO, USPTO-only gate

Remove `EuipoProvider` from the gate entirely. The gate
becomes a single-provider (USPTO) check; the EU half of the
coverage is conceded.

**Advantages:**

- Dead-simple: ~50 LOC of deletions, no replacement code.
- One fewer credential to manage.

**Disadvantages:**

- The gate is regressing to a single-jurisdiction check. A
  candidate that has only an EU registration (no US mark)
  comes back Clear, which is exactly the silent-failure
  pattern this ADR exists to prevent.
- The trademark gate is *more* conservative with both
  providers (Principle 5). Removing one provider makes the
  gate less conservative on the EU axis.
- The work is in the wrong direction: removing functionality
  to fix a wiring bug.

**Cost Implications:** Trivial in code; the cost is the lost
EU coverage, which is real and silent.

**Risk Assessment:** Medium. The lost EU coverage is a
strict regression on the conservativity axis that Principle
5 and the EUIPO half of the gate were introduced to provide.

---

### Option C: Keep the COPLA endpoint, document the limitation

Leave the EUIPO adapter on the dead COPLA endpoint and add
a comment explaining that EUIPO silently returns zero hits
on every query.

**Advantages:**

- Zero code change.

**Disadvantages:**

- A "documented limitation" with no operator-actionable
  remediation is a textbook recipe for the next contributor
  to either reintroduce the bug or assume it is intentional.
- The gate is silently wrong in production. Every
  `dominus run` since the COPLA retirement has been
  clearing EU-only conflicts. The bias is invisible until
  the operator acquires a name with an EU mark and gets a
  cease-and-desist.

**Cost Implications:** Zero code work; the cost of the bias
is real and silent, exactly as in ADR-0012's Option D.

**Risk Assessment:** High. The bias is on the wrong axis of
Principle 5 (under-conservative on EU coverage), and it
cancels exactly the strict-USPTO-TLD rule that ADR-0012 just
landed.

## Decision

**Chosen option: Option A — migrate to Trademark Search
1.1.0.**

The provider-agnostic abstraction (Principle 1) is exactly
what makes this migration a one-file change. The
`TrademarkProvider` interface in
`src/providers/trademark/trademark-provider.ts` is unchanged;
`EuipoProvider` is the only file that learns the new wire
format. The gate, the detector, and the upstream scoring
engine are not touched.

For each decision driver:

- **Driver 1 (Principle 6)** — the EUIPO half of the gate
  stops being a no-op. A candidate with an EU-registered
  mark (no US mark) is now Blocked instead of Clear.
- **Driver 2 (EU jurisdiction coverage)** — restored, with
  the same broad-coverage intent as before, against the new
  API.
- **Driver 3 (no paid API)** — the new API uses the same
  free EUIPO subscription model. No new vendor, no new
  payment.
- **Driver 4 (provider-agnostic)** — the change is entirely
  inside `EuipoProvider`. The gate's `TrademarkMatch[]`
  contract is unchanged.
- **Driver 5 (defensive against RSQL injection)** — search
  terms are sanitised against RSQL metacharacters
  (`*`, `'`, `"`, `\\`, whitespace) before being interpolated
  into the `?query=` parameter.

For each rejected alternative:

- **Option B (drop EUIPO)** concedes EU coverage, which is
  the *primary* reason the EUIPO provider exists. Removing
  it is a regression, not a fix.
- **Option C (keep COPLA, document)** preserves the silent
  failure mode that the strict-USPTO-TLD rule was designed
  to *avoid*. The bias is the wrong kind of conservatism.

## Consequences

### Positive

- **EU coverage restored.** Real EU marks surface again.
  The previous silent-zero failure is replaced with a
  working provider.
- **Provider abstraction validated.** A wire-format
  migration on one of two providers touches one file. This
  is the resilience Principle 1 was designed to provide.
- **Actionable error message.** A 401/403 from the new
  endpoint tells the operator exactly what to verify
  (`EUIPO_CLIENT_ID`, Trademark Search 1.1.0 subscription).
  The old "unauthorised" message was unhelpful.
- **RSQL injection closed.** Search terms are sanitised
  before RSQL interpolation. The character set allowed in
  a term is the alphanumeric core; RSQL metacharacters are
  stripped.
- **Broader status filter.** `CANCELLED`, `SURRENDERED`,
  `INVALID`, `LAPSED`, `REVOKED` are now treated as inactive
  in addition to the previous `REFUSED`, `WITHDRAWN`,
  `EXPIRED` filter.

### Negative

- **EUIPO subscription must be re-issued.** EUIPO issues
  new credentials for the Trademark Search 1.1.0 API; the
  operator has to re-register (free, 1-3 business days for
  identity verification). This is operational, not
  code-side; it is documented in the migration plan.
- **OAuth2 token URL is a placeholder default.** The
  default `EUIPO_AUTH_URL` is `https://euipo.europa.eu/oauth2/token`,
  a path that may have changed. The operator can override
  the env var when the official endpoint is confirmed. A
  follow-up ADR can pin the default once the URL is
  verified.
- **Pagination is not implemented.** The first 50 hits are
  returned; the tail is silently dropped for terms with
  more than 50 active EU marks. At single-user scale this
  is invisible; a follow-up can iterate the `page`
  parameter when `totalElements > size`.
- **The legacy `trademarks`/`total` response shape is
  accepted for backward compat.** This makes the parser
  more permissive than strictly necessary. The trade-off is
  robustness to EUIPO API evolution and to pre-production
  environments; the alternative is to break the test
  fixtures on every EUIPO envelope rename.

### Compliance and Security Implications

- No new PII, no credentials, no API keys in code or
  tests. The `X-IBM-Client-Id` reuses the OAuth2
  `client_id`, which is the operator's existing secret.
- RSQL injection is mitigated by character stripping. A
  term like `'; DROP TABLE` becomes `droptable` after
  sanitisation; the RSQL parser sees a benign wildcard
  query.
- The new API requires the operator to opt in to the
  Trademark Search 1.1.0 subscription; until they do, the
  EUIPO half of the gate is still effectively a no-op
  (the new endpoint returns 401/403, which the gate
  surfaces as `Unverified` with a helpful error message).

### Migration and Monitoring Plan

- **Migration:** no code migration. The provider is
  updated in place; the gate's behaviour is restored on
  the next `dominus run` once the operator's
  `EUIPO_CLIENT_ID` is valid against the new API.
- **Operator actions:**
  1. Register for the Trademark Search 1.1.0 subscription
     at `https://euipo.europa.eu/ohimportal/en/open-data`
     (free, 1-3 business days).
  2. Paste the issued `client_id` and `client_secret`
     into `EUIPO_CLIENT_ID` and `EUIPO_CLIENT_SECRET`
     in `.env`.
  3. Confirm `EUIPO_AUTH_URL` is correct; override if
     EUIPO has rotated the OAuth2 token endpoint.
  4. Run a smoke test: `dominus run --brandable nike`
     should produce a `verdict=blocked` (Nike is a
     registered EU mark).
- **Monitoring:** the gate's existing observability
  surfaces 401/403 as `ProviderError` with
  `code=EUIPO_UNAUTHORIZED`. A simple
  `dominus run | grep "EUIPO_UNAUTHORIZED"` count over a
  week gives a baseline of how often the new endpoint is
  failing (expect near-zero once the subscription is
  active).
- **Rollback:** revert the four commits. The
  `TrademarkProvider` contract is unchanged; the previous
  COPLA-based code is bit-recoverable. The bias returns
  to the silent-zero failure mode, which is the exact
  state before this ADR.

### Validation

- 20 unit tests in
  `src/providers/trademark/__tests__/trademark-providers.test.ts`
  cover the new wire format: RSQL query string, RSQL
  metacharacter sanitisation, `X-IBM-Client-Id` header,
  paged response envelope, legacy response backward
  compat, broader status filter, and the actionable 401
  error message.
- All 344 pre-existing tests in the repository pass
  after the change (USPTO provider and gate tests are
  untouched; the change is provider-local).
- Production validation: a `dominus run --brandable nike`
  should produce a `verdict=blocked` for `nike.com` (USPTO
  match) and a `verdict=blocked` for `nike.eu` and
  `nike.co.uk` once the EUIPO subscription is active. The
  pre-migration behaviour for the EU candidates was a
  silent Clear.

### Follow-up Backlog

- The `EUIPO_AUTH_URL` default is a placeholder. Pin it
  once the official current URL is verified.
- Pagination: iterate the `page` parameter when
  `totalElements > size` to surface tail hits on
  high-volume search terms.
- A future hardening can swap the curated status filter
  for an allow-list of EUIPO status codes once the EUIPO
  documentation stabilises around the new values.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS
ADRs should be consistent with the product vision in
the ADR series starting at `docs/adr/0001-project-architecture.md`. Template:
`.claude/skills/adr/template.md`.*
