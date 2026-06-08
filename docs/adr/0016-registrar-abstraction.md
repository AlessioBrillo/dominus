# ADR-0016: Registrar Provider Abstraction

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0004 (provider abstraction pattern) |
| **Project** | DOMINUS |

## Context

DOMINUS is a decision-support tool, not a domain trading bot — the operator
evaluates candidates inside DOMINUS and manually executes purchases,
renewals, and transfers through their chosen registrar's web interface.
However, the project's ADR-0001 notes that "a future upgrade to paid API
providers requires only a new implementation file swapping in."

The registrar layer is the last external interface without a provider
abstraction. The portfolio manager tracks `registrar` as a free-text field
in `portfolio_entries`, but there is no programmatic way to:

1. Check registration/renewal prices before purchase.
2. Execute a purchase from a pipeline recommendation.
3. Bulk-check renewal dates for the renewal clock.
4. List domains from the registrar to reconcile against the portfolio.

Adding a RegistrarProvider interface now, even with a no-op manual
implementation, establishes the abstraction before it is needed — consistent
with ADR-0004's principle of "interface-first, implementation-later."

## Decision Drivers

1. **Provider-agnostic design** — the portfolio and workflow code must never
   import a registrar-specific SDK. The interface must be the only contract.
2. **Safe default** — the default implementation must do nothing. DOMINUS
   must not accidentally purchase or modify domains without the operator's
   explicit action through their registrar dashboard.
3. **Future-proof types** — the interface types must cover the operations
   that real registrar APIs support: price checks, purchases, domain listing,
   renewal cost queries, and DNS management info.
4. **Composition-root wiring** — swapping from manual to automated must be a
   one-line change in `src/index.ts`, consistent with every other provider.

## Considered Options

### Option A: Full Interface with Manual Provider (CHOSEN)

Define a `RegistrarProvider` interface with four methods (`checkPrice`,
`purchase`, `listDomains`, `getRenewalCost`) and a `ManualRegistrarProvider`
that returns "not available" for every operation.

**Advantages:**
- Complete abstraction: any current or future registrar can implement the
  interface.
- Safe default: the manual provider cannot accidentally purchase or modify
  anything.
- Consistent with ADR-0004 pattern.
- The interface types serve as documentation for future implementers.

**Disadvantages:**
- Interface may need revision when a real registrar API is implemented
  (e.g., a registrar may not support `listDomains` or may require
  additional fields in the purchase request).
- Four methods of boilerplate in the manual provider.

**Cost Implications:** Zero monetary cost. ~1 hour to design the interface,
implement ManualRegistrarProvider, write tests, and document.

**Risk Assessment:** Low. The interface is designed conservatively; methods
can be added without breaking existing implementations.

---

### Option B: No Interface, Free-Text Registrar Field Only

Keep the current approach: `portfolio_entries.registrar` is a free-text
field. No programmatic registrar interaction.

**Advantages:**
- Zero new code.
- The operator is already used to entering registrar names manually.

**Disadvantages:**
- Every future registrar integration requires rewriting how the portfolio
  manager interacts with external registrars.
- No type contract for implementers to follow.
- Inconsistent with every other external interface in the project.

**Cost Implications:** Zero. But deferred cost of future integration.

**Risk Assessment:** Low. But the deferred cost grows as the codebase
evolves.

---

### Option C: Partial Interface with Only Price Check

Define a `RegistrarPriceProvider` interface with only `checkPrice` and
`getRenewalCost`, deferring purchase and listing to a future interface.

**Advantages:**
- Smaller surface area.
- Price queries are the most commonly needed operation.
- Less boilerplate in the manual provider.

**Disadvantages:**
- Two interfaces (price + operations) where one would suffice.
- Future implementers need to implement two interfaces instead of one.
- Inconsistent with the single-interface-per-provider pattern in ADR-0004.

**Cost Implications:** Zero monetary cost. Less upfront, more integration
cost later.

**Risk Assessment:** Low. But creates a precedent of splitting what should
be one concern into multiple interfaces.

---

## Decision

**Chosen option: Option A — Full Interface with Manual Provider**

The interface is defined in `src/providers/registrar/registrar-provider.ts`
with four methods matching the operations that real registrar APIs support:

- `checkPrice(domains: string[]): RegistrarPriceCheck[]` — bulk price check
  for registration, renewal, and transfer.
- `purchase(request: RegistrarPurchaseRequest): RegistrarPurchaseResult` —
  execute a domain registration.
- `listDomains(): RegistrarDomainInfo[]` — list all domains under management.
- `getRenewalCost(domain: string): number` — single-domain renewal price.

All methods return nullable or empty values in the manual implementation.
The provider is not wired into the pipeline orchestrator or portfolio manager
by default — the operator must explicitly switch it in `src/index.ts`.

## Consequences

### Positive
- The registrar layer now follows the same abstraction pattern as every other
  external provider (ADR-0004).
- A community contributor can write a Namecheap, GoDaddy, or Cloudflare
  provider by implementing one interface and adding the dependency — no
  core logic changes.
- The interface documents exactly what operations a registrar must support
  for full integration.

### Negative
- The manual provider is pure boilerplate. It will never be used for actual
  operations — it exists only to satisfy the type contract.
- Wiring the provider into the portfolio manager is deferred until a real
  implementation exists. The interface is defined but unused by business
  logic today.

### Compliance and Security Implications
- The manual provider performs no network calls and stores no credentials.
- Real registrar implementations will require API keys stored in `.env`
  (gitignored). The interface is designed so that credentials are passed
  via the constructor, never via environment variables read inside the
  provider (consistent with ADR-0004).

### Migration and Monitoring Plan
- **Migration**: None. The interface is additive and does not change existing
  portfolio behaviour.
- **Adding a real registrar**: (1) Implement `RegistrarProvider`, (2) wire
  it in `src/index.ts`, (3) add `registered_through_api` column to
  `portfolio_entries` when a purchase succeeds programmatically.
- **Rollback**: Revert to `ManualRegistrarProvider` by changing one
  constructor argument.

### Validation
- `ManualRegistrarProvider` has 6 unit tests covering all interface methods
  and edge cases.
- Production validation: the provider is never called by default — it is
  a passive interface until activated.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.
Template: `.claude/skills/adr/template.md`.*
