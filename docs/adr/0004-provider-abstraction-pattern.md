# ADR-0004: Provider Abstraction Pattern

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted (retrospective) |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0003, ADR-0005, ADR-0006 |
| **Project** | DOMINUS |

## Context

DOMINUS depends on six categories of external data: DNS availability, RDAP
registration status, WHOIS ownership data, trademark registrations (USPTO +
EUIPO), keyword search volume, and comparable sales data. Every one of these
data sources has multiple possible implementations with different cost,
latency, and reliability profiles:

- **DNS**: Node built-in `dns` module (free), Google DNS over HTTPS, Cloudflare
  1.1.1.1 API, direct root-server queries.
- **RDAP**: IANA RDAP bootstrap (free), RESTful RDAP per-TLD server queries
  (free), WHOIS port-43 fallback (free).
- **Trademark**: USPTO free search (no key), USPTO bulk data files, EUIPO
  Trademark Search 1.1.0 (OAuth2, free registration), WIPO Global Brand
  Database, commercial TM API (paid, 0.10 EUR per lookup).
- **Keyword**: Google Keyword Planner manual export (free), SEMrush API
  (paid), Ahrefs API (paid), Google Ads API (requires Ads account).
- **Comparables**: NameBio manual CSV export (free), NameBio API (paid),
  DNJournal (free, HTML scrape), Afternic DLS data (paid).

The project budget is zero-cost for the initial implementation, but the architecture must support
future upgrades to paid APIs without changing business logic. Every external
data interaction must be behind an interface so that swapping the
implementation is a one-file change.

## Decision Drivers

1. **Zero-cost mandate** — all initial implementations must be free. Paid
   versions are planned for the future when the budget allows.
2. **Swap without core changes** — changing from the free USPTO provider to a
   paid commercial API must not require editing the trademark gate, the
   scoring engine, or the pipeline orchestrator.
3. **Single-responsibility implementations** — each provider file does exactly
   one thing (make API calls, parse responses, handle errors). Cross-cutting
   concerns like caching and retrying are handled by decorator wrappers.
4. **Testability** — business logic must be testable without network access.
   Mock providers should satisfy the same interface as real ones.

## Considered Options

### Option A: Interface per Provider + Dependency Injection + Decorators (CHOSEN)

Every external data source has a TypeScript interface in its own file. All
business logic receives provider instances via constructor injection. Decorator
classes (`CachedTrademarkProvider`, `RetryingTrademarkProvider`) wrap a
provider to add cross-cutting behaviour without modifying the real
implementation.

**Advantages:**
- Swapping a provider requires changing exactly one constructor call in
  `src/index.ts`. The trademark gate, scoring engine, and pipeline stages are
  unchanged.
- Caching and retrying are compositional: add a `CachedTrademarkProvider`
  around any `TrademarkProvider` without modifying either class.
- Testing: the scoring engine receives `MockKeywordProvider` and
  `MockCompsProvider` in tests. No API credentials, no network, no flaky tests.
- Each provider file is small (50-200 lines) with a single responsibility.
- The `warnEuipoIfMissing` pattern in `src/index.ts` logs a warning when a
  provider is not configured but does not crash — graceful degradation.

**Disadvantages:**
- Constructor injection at scale creates a large wiring function
  (`src/index.ts` is 137 lines of setup). A future DI container would reduce
  boilerplate but adds a dependency.
- The decorator pattern requires each decorator to implement the full interface,
  forwarding untouched methods to the inner provider. This is repetitive for
  interfaces with many methods (though most provider interfaces have 1-2
  methods).

**Cost Implications:** Zero monetary cost. ~30 hours to design interfaces,
implement decorators, and wire dependencies.

**Risk Assessment:** Low. The pattern is well-established (Repository pattern,
Decorator pattern, Dependency Injection). No experimental techniques.

---

### Option B: Direct API Calls in Business Logic (REJECTED)

The trademark gate calls the USPTO API directly via `fetch`. The scoring engine
calls a keyword API directly. Provider implementations are not abstracted.

**Advantages:**
- Less code: no interfaces, no decorators, no constructor wiring.
- Faster to write initially.

**Disadvantages:**
- Swapping from free USPTO to paid TM API requires editing the trademark gate,
  the trademark gate stage, and potentially the orchestrator.
- Testing requires network access or monkey-patching `global.fetch` — both
  fragile and slow.
- API credential management is spread across the codebase instead of
  centralised in provider files.
- Rate limiting and retry logic would be duplicated across callers instead of
  centralised in one decorator.

**Cost Implications:** Zero monetary cost. Higher maintenance cost over time.

**Risk Assessment:** High. The tight coupling between business logic and
provider implementations makes the system brittle. Swapping one provider
risks breaking unrelated features.

---

### Option C: Abstract Base Classes with Template Method

Replace interfaces with abstract base classes that define the provider contract
and implement shared behaviour (logging, error wrapping, timeout).

**Advantages:**
- Shared behaviour (logging, error handling) can be implemented once in the
  base class.
- Runtime type checking via `instanceof` is possible.

**Disadvantages:**
- TypeScript interfaces are more flexible (a class can implement multiple
  interfaces, but extend only one base class).
- Base classes create a stronger coupling than interfaces: changing the base
  class signature requires updating all implementations.
- The decorator pattern works less cleanly with base classes (a decorator
  would need to extend the same base class, not just implement the interface).
- Testing with a mock provider that does not extend the base class would fail
  type checks if business logic expects the base class type.

**Cost Implications:** Zero monetary cost. Comparable to Option A in effort.

**Risk Assessment:** Low, but interfaces are strictly more flexible for DI and
testing. Option C provides no advantage over Option A.

---

## Decision

**Chosen option: Option A — Interface per Provider + DI + Decorators**

The rationale is driven by the decision drivers:

1. **Zero-cost mandate**: All six initial providers are free. The `NodeDnsProvider`
   uses the built-in `node:dns` module. The `PublicRdapProvider` uses free
   RDAP endpoints. The `UsptoCasesProvider` uses the public USPTO search
   (no key required). The `ManualKeywordProvider` and `ManualCompsProvider`
   read local files. The `NodeWhoisProviderWithIanaFallback` uses port-43 WHOIS.

2. **Swap without core changes**: A future `NameBioApiProvider` would implement
   the same `CompsProvider` interface as the existing `ManualCompsProvider`.
   The scoring engine receives whichever implementation is wired in
   `src/index.ts` — it never knows which one it is calling.

3. **Decorator patterns**: The `CachedTrademarkProvider` wraps any
   `TrademarkProvider` with a 7-day TTL cache backed by SQLite. The
   `RetryingTrademarkProvider` wraps any `TrademarkProvider` with exponential
   backoff and jitter. Both are compositional: wrap them in any order, add
   either without the other, or use the raw provider.

4. **Testability**: All tests use mock providers. The scoring engine test
   passes `MockKeywordProvider` and `MockCompsProvider`. The pipeline
   orchestrator test passes mock stages. No test requires API credentials or
   network access.

Option B (direct calls) was rejected because it violates every decision driver.
Option C (abstract base classes) was rejected because it is less flexible than
interfaces for the decorator pattern and adds no compensating benefits.

## Consequences

### Positive
- The six provider interfaces are defined in six files totalling ~100 lines.
  Each interface has 1-3 methods with clear input/output contracts.
- Six free implementations exist; paid versions can be added as separate files
  without touching any other module.
- The caching and retrying decorators centralise cross-cutting concerns in
  ~150 lines of code total.
- All 56 test files rely on mocked or in-memory providers — zero flaky
  network-dependent tests.

### Negative
- The wiring in `src/index.ts` is verbose (137 lines). A future DI container
  (e.g., `tsyringe`) would reduce boilerplate but adds a dependency.
- The `NodeWhoisProviderWithIanaFallback` combines WHOIS lookup + IANA server
  mapping in one class, slightly violating single responsibility. The
  trade-off is acceptable to avoid an extra abstraction layer for a simple
  TCP socket call.
- Adding a new provider ecosystem (e.g., RegistrarProvider) requires defining
  the interface, implementing it, and wiring it in `src/index.ts` — the fixed
  cost is ~30 lines of boilerplate.

### Compliance and Security Implications
- Free provider implementations never require API keys, tokens, or credentials.
  The EUIPO provider requires OAuth2 credentials (free registration), stored
  in `.env` which is gitignored.
- Manual providers read local files. File paths are validated against
  directory traversal patterns in `src/config.ts`.
- Provider interfaces never expose raw response bodies to callers — all
  parsing and validation happens inside the provider implementation.

### Migration and Monitoring Plan
- **Migration**: None. This ADR documents the existing design.
- **Adding a paid provider**: (1) Create a new file implementing the existing
  interface, (2) wire it in `src/index.ts`, (3) remove the free
  implementation if desired. Core logic unchanged.
- **Rollback**: Revert to the free implementation by changing one import in
  `src/index.ts`.

### Validation
- Each provider has a test file with 2-24 tests covering happy path, error
  handling, timeout, rate limiting, and response parsing.
- The `providers-command.ts` and `/api/providers` health endpoint allow the
  operator to verify that each provider is operational.
- Production validation: `dominus providers status` shows the status of all
  five provider categories.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision previously documented in
`dominus-product-vision.md` (v0.2), now superseded by this ADR series.
Template: `docs/adr/template.md`.*
