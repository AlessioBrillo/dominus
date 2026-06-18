# ADR-0001: Project Architecture and Technology Decisions

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Superseded (see ADR-0026, ADR-0027) |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0003, ADR-0004, ADR-0005 |
| **Project** | DOMINUS |

## Context

DOMINUS is a single-user decision-support tool for buying and reselling DNS
domains on the aftermarket. The operator has a tight budget (~500 EUR) and
explicitly rules out paid APIs for the initial implementation. The goal is not
automation of buying or selling but producing better purchase and portfolio
decisions than the market average — a qualitative improvement, not a
quantitative one.

At project inception, the following constraints were known:

1. **Budget**: zero-cost infrastructure. The tool must run on a single
   commodity machine (laptop or entry-level VPS) with no monthly fees beyond
   the domain renewal costs it tracks.
2. **Scale**: single user, tens to low hundreds of domains. No multi-tenancy,
   no concurrent access, no horizontal scaling requirement.
3. **Persistence**: all data (candidates, scores, portfolio, trademark
   results, outcomes) must survive process restarts and be queryable offline.
4. **Interface**: the operator needs both a CLI for scripting/automation and a
   REST API for future integration with other tools or a dashboard.
5. **Language**: TypeScript was chosen for type safety, broad ecosystem, and
   the author's existing proficiency.
6. **Module system**: ESM (ECMAScript Modules) was chosen for compatibility
   with the modern Node.js ecosystem and tree-shakeable imports.

These constraints drove every subsequent technology decision in this ADR.

## Decision Drivers

1. **Zero-cost mandate** — every dependency and service must be free at the
   point of use. This rules out cloud databases, paid SaaS APIs, and
   proprietary runtimes.
2. **Single-user simplicity** — no need for connection pooling, concurrent
   write handling, or user authentication. The database and server can be
   embedded in the same process.
3. **Offline-first** — the tool must function without a network connection for
   core operations (scoring, portfolio management, outcome tracking). Only
   provider lookups (DNS, RDAP, trademark) require connectivity.
4. **Scriptable + integrable** — CLI for interactive use and cron jobs, REST
   API for a future dashboard or third-party integration.
5. **Type safety** — the scoring engine is the core asset; type errors in
   weight computation or price suggestion are unacceptable.

## Considered Options

### Option A: Node.js + Express + SQLite (CHOSEN)

A monolithic backend written in TypeScript (strict mode, ESM) using Express
for the REST API, Commander for the CLI, and better-sqlite3 for persistence.

**Advantages:**
- Zero-cost: all dependencies are MIT/Apache-2.0 licensed open source.
- Single-process: the CLI and API share the same codebase, database, and
  dependency injection container. No IPC, no socket files, no docker-compose
  for development.
- SQLite via better-sqlite3 is synchronous and single-user optimal: no async
  await for queries, no connection pool, no write conflicts. WAL mode allows
  concurrent reads during writes without locking.
- Express is the most widely-used Node.js HTTP framework with mature
  middleware ecosystem and extensive documentation.
- Commander is the de facto standard for Node.js CLI tools.
- The entire application compiles to a single `dist/` directory with no
  external runtime dependencies beyond Node.js >= 20.

**Disadvantages:**
- SQLite does not scale to concurrent multi-user writes. At DOMINUS scale
  (single user) this is irrelevant, but a future multi-tenant version would
  require migrating to Postgres.
- Monolithic architecture means the API and CLI share the same memory space:
  a memory leak in the scoring engine takes down both interfaces.
- Express 5.x is relatively new (stable release April 2025) with a smaller
  community than Express 4.x.

**Cost Implications:** Zero monetary cost. Development effort ~80 hours for the
initial scaffold (routing, DI wiring, CLI framework, database layer).

**Risk Assessment:** Low. All dependencies are mature and well-maintained.
Express 5.x API stability is assured by the Express team's semver commitment.

---

### Option B: Rust + Actix + SQLite

A compiled-language backend in Rust with the Actix web framework and
rusqlite for SQLite access.

**Advantages:**
- Higher raw performance for the scoring engine (relevant if the number of
  candidates grows to 10,000+ per run).
- Compile-time memory safety guarantees eliminate an entire class of bugs.
- Smaller runtime footprint (static binary, no Node.js dependency).
- Better CPU-bound throughput for the trademark matching loop (Levenshtein
  distance on thousands of marks).

**Disadvantages:**
- Significant ramp-up cost: the author would need to learn Rust, Actix, and
  the rusqlite ecosystem.
- Smaller ecosystem for domain-specific needs: no `psl` equivalent without
  FFI, no mature WHOIS/DNS client libraries.
- Longer compile cycles for a single-developer project.
- Harder to iterate: TypeScript's type system catches most errors while being
  far more ergonomic for rapid prototyping.
- The scoring engine is not computationally intensive enough to benefit from
  Rust's performance advantage (sub-millisecond per domain in TypeScript).

**Cost Implications:** Zero monetary cost. ~200-400 hours developer ramp-up, a
5x increase over the TypeScript option for no measurable benefit at DOMINUS
scale.

**Risk Assessment:** Medium-high. Developer productivity would drop
dramatically during the learning phase.

---

### Option C: Python + FastAPI + SQLite

A Python backend with FastAPI for REST and SQLAlchemy for database access.

**Advantages:**
- Fast to prototype with Python's dynamic typing.
- FastAPI has excellent OpenAPI documentation generation.
- Rich ecosystem for data analysis (pandas, numpy) that could feed the
  backtest engine.

**Disadvantages:**
- No compile-time type checking. The scoring engine's correctness depends on
  runtime discipline, which is harder to enforce in a single-developer
  project.
- Python's async story (asyncio) is less mature than Node.js for high-volume
  DNS/HTTP provider calls.
- worse-sqlite3 does not exist for Python — SQLAlchemy + aiosqlite adds
  abstraction layers that complicate the simple SQLite use case.
- CLI tooling requires a separate library (Click or Typer); Commander has no
  Python equivalent with the same ergonomics.

**Cost Implications:** Zero monetary cost. Development effort comparable to
Option A, but higher maintenance cost due to weaker type guarantees.

**Risk Assessment:** Medium. The lack of compile-time type checking is the
primary risk for the scoring engine — a silent type error could produce bad
buy recommendations without any runtime signal.

---

## Decision

**Chosen option: Option A — Node.js + Express + SQLite**

The rationale is driven by the project constraints:

1. **Zero-cost mandate**: Node.js, npm, and all selected libraries are free.
   No paid services, no cloud credits, no licensing fees.

2. **Single-user simplicity**: better-sqlite3 is the fastest option for a
   single-process, single-user SQLite workload. It is synchronous, which
   eliminates an entire class of concurrency bugs and makes the code easier
   to reason about.

3. **TypeScript strict mode** provides compile-time safety for the scoring
   engine. Runtime errors in `expected_value` or `suggested_buy_max`
   computations are caught at compile time, not after a bad purchase. The
   `tsconfig.json` settings (`noUncheckedIndexedAccess`, `noImplicitOverride`,
   `exactOptionalPropertyTypes`) add additional safety layers.

4. **ESM module system** ensures compatibility with modern Node.js features
   and prevents the CommonJS/ESM interop issues that plague mixed projects.

5. **Express 5** provides the REST API surface for future extensibility while
   being mature enough for production use. Commander provides the CLI surface
   with minimal boilerplate.

6. **Offline-first**: SQLite embeds the database in the application process.
   The core scoring engine runs entirely on local data (intrinsic signal,
   cached keyword/comps data). Only DNS, RDAP, and trademark lookups require
   network connectivity.

Option B (Rust) was rejected because the productivity cost outweighs the
performance benefit at the expected scale. Option C (Python) was rejected
because the lack of compile-time type safety is too risky for the scoring
engine, which is the project's core asset.

## Consequences

### Positive
- Single `npm install` + `npm run build` produces a runnable application with
  no external dependencies beyond Node.js >= 20.
- The CLI and API share the same codebase, types, and database — no
  duplication of business logic.
- TypeScript strict mode catches scoring engine errors at compile time.
- better-sqlite3 provides sub-millisecond query performance for all
  portfolio operations.
- Express middleware pattern cleanly separates concerns (logging, error
  handling, routing).

### Negative
- Monolithic architecture: a crash in the scoring engine takes down both the
  API and CLI. Mitigation: the CLI is stateless (runs as a command, exits),
  so a crash only affects the current invocation. The API runs in a separate
  process when deployed.
- SQLite write lock contention is possible during bulk imports combined with
  API requests. Mitigation: WAL mode and the single-user nature make this
  unlikely in practice.
- Migrating to Postgres in the future would require rewriting all repository
  classes and changing the migration runner.

### Compliance and Security Implications
- SQLite is embedded, so no database credentials or network ports are exposed.
- The application binds to 127.0.0.1 by default (localhost only), minimising
  the attack surface.
- Input domain names are validated against RFC-1123 rules before any provider
  call, preventing injection vectors.
- All SQL queries use parameterised statements (better-sqlite3 API enforces
  this), preventing SQL injection.

### Migration and Monitoring Plan
- **Migration**: None. This ADR documents the existing architecture.
- **Rollback**: The git history on `master` contains the full evolution. A
  technology migration (e.g., to Postgres) would be a new ADR and a separate
  feature branch.
- **Validation**: The architecture is validated by the working implementation:
  all 414+ tests pass, the CLI responds to `dominus --help`, and the API
  responds to `GET /api/health`.

### Validation
- The architecture was validated incrementally during development.
- `npm run typecheck` enforces compile-time safety on every commit.
- `npm test` runs 414+ tests that exercise the full stack from CLI commands
  through database persistence to API responses.
- The CI pipeline (`.github/workflows/ci.yml`) runs typecheck, build, lint,
  and test on every push and PR to `master`.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision previously documented in
`dominus-product-vision.md` (v0.2), now superseded by this ADR series.
Template: `docs/adr/template.md`.*
