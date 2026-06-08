---
name: architecture-guardian
description: >
  Architectural governance framework for DOMINUS — personal DNS domain investment tool.
  Enforces 6 architecture principles, pipeline-stage module separation,
  TypeScript coding conventions, provider abstraction patterns, scoring engine
  conservatism rules, and testing standards for a single-user Node.js + SQLite stack.
when_to_use: >
  Must be loaded when the user discusses any implementation, code generation,
  module scaffolding, database schema design, provider integration, scoring logic,
  pipeline orchestration, portfolio management, or test writing. Triggering keywords
  include: implement, scaffold, provider, pipeline, scoring, portfolio, trademark,
  RDAP, DNS, SQLite, schema, migration, interface, adapter, weight, signal,
  candidate, closeout, brandable, renewal, drop, repository, controller, route.
user-invocable: false
---

# Architecture Governance Framework — DOMINUS

This document defines **binding engineering standards** for all code and architecture decisions within DOMINUS. Every implementation MUST conform to these rules.

---

## 1. Foundational Architecture Principles

Every technical decision MUST satisfy ALL relevant principles below. If a choice violates any principle, it is rejected regardless of other benefits.

### Principle 1: Provider-Agnostic Abstraction

- **Rule**: NEVER import, call, or reference any external data provider SDK/API directly from business logic, scoring engine, or pipeline orchestration code.
- **Enforcement**: All external data interactions go through dedicated provider interfaces (`WhoisProvider`, `CompsProvider`, `TrademarkProvider`, `KeywordProvider`). Adding a new data source means writing exactly one adapter. Zero changes occur in any other layer.
- **Violation example**: Calling `dns.resolve()` directly inside a scoring signal evaluator.
- **Compliant pattern**: `whoisProvider.check(domainName)` where `whoisProvider` implements the `WhoisProvider` interface — whether it uses Node `dns`, RDAP HTTP, or WHOIS port-43 internally.

### Principle 2: Decision-First UX

- **Rule**: Every candidate domain MUST answer exactly one question — *buy or pass*. Every portfolio domain MUST answer exactly one question — *keep, drop, or reprice*.
- **Enforcement**: All pipeline stages exist to serve this decision. No feature that adds cognitive load without improving decision quality is permitted. The scoring engine output (`expected_value`, `confidence`, `suggested_buy_max`, `suggested_list_price`) is the single source of truth for the buy decision.
- **Explicit exception**: Debug/logging views are permitted behind a `--verbose` flag or equivalent.

### Principle 3: Pipeline Sequential

- **Rule**: The five core pipeline stages MUST execute in strict order: Candidate Generation → DNS Pre-filter → RDAP Confirmation → Scoring → Trademark Gate. No stage may execute before its predecessor completes.
- **Enforcement**: Each stage takes the output of the previous stage as input. The pipeline orchestrator is the only component that coordinates stage execution; individual stages never call each other.
- **Rationale**: Each stage filters out candidates (e.g., DNS removes registered names, Trademark removes legal risks). Running out of order would waste compute or produce invalid results.

### Principle 4: Cost is a Functional Requirement

- **Rule**: Every domain's renewal cost, acquisition cost, and suggested buy/sell prices are first-class data in the system. No domain exists in the portfolio without a renewal clock and a drop verdict.
- **Enforcement**:
  - Every portfolio entry stores: `acquiredAt`, `renewalDate`, `acquisitionCost`, `renewalCost`, `currentScore`, `dropVerdict`
  - `suggested_buy_max` is computed BEFORE any purchase decision and is never exceeded
  - Drop logic runs automatically on a configurable schedule (default: monthly)
  - Premium registry domains are rejected at the RDAP stage (rule d'oro: "ignora i nomi premium del registry")

### Principle 5: Scoring Conservatism

- **Rule**: The scoring engine MUST be more conservative than commercial appraisal tools, never more generous.
- **Enforcement**:
  - Default weight configuration penalizes hyphens, numbers, long strings, and non-.com TLDs
  - `suggested_buy_max` is computed as a fraction of `expected_value` (default: 40-60%), not the full value
  - `confidence` below a threshold (default: 0.3) forces a hard pass regardless of `expected_value`
  - Every weight adjustment must be justifiable against real comparable sales, not intuition

### Principle 6: Trademark Gate is Non-Negotiable

- **Rule**: No candidate reaches a buy recommendation without passing the trademark gate. This is not skippable, not configurable, not optional.
- **Enforcement**: The pipeline orchestrator MUST reject any candidate that matches a registered trademark in USPTO or EUIPO databases. The gate runs last (after scoring) to avoid wasting API calls on low-value candidates, but it MUST run before any buy verdict is produced.
- **Exception for closeouts**: Even if a domain is in a closeout auction, the trademark check runs. A TM match blocks the recommendation regardless of auction urgency.

---

## 2. Source Code Modules

Every source file MUST belong to exactly one module. Cross-module dependencies follow strict rules.

| Module | Responsibility | MVP scope | Dependencies |
|--------|--------------|-----------|--------------|
| `src/providers/` | Provider interfaces + implementations (Whois, RDAP, Comps, Trademark, Keyword) | ✅ Free/public implementations | None |
| `src/pipeline/` | Pipeline orchestrator + stage runner for the 5-stage flow | ✅ | `src/providers/`, `src/scoring/` |
| `src/scoring/` | Heuristic scoring engine: signals, weights, aggregator, price suggestions | ✅ (core asset) | `src/providers/` (for keyword/comps data) |
| `src/portfolio/` | Domain registry, renewal clock, drop verdict engine | ✅ | `src/db/` |
| `src/trademark/` | USPTO/EUIPO checker + match detector | ✅ (gate) | `src/providers/` |
| `src/db/` | SQLite schema, migrations, repository classes | ✅ | None |
| `src/cli/` | CLI interface, argument parsing, output formatting | ✅ (or dashboard) | `src/pipeline/`, `src/portfolio/` |
| `frontend/` | React/Vite/Tailwind dashboard (minimal) | Optional (can be CLI-only) | `src/` (via API routes) |

### Cross-module rules
- Dependencies MUST NOT create circular references. The dependency graph is a DAG.
- Inner modules MUST NOT depend on outer modules (e.g., `src/scoring/` never imports from `src/cli/`).
- Provider implementations within `src/providers/` MUST NOT import from any other module.
- `src/db/` is the only module that imports `better-sqlite3` or any database driver.

---

## 3. TypeScript Coding Conventions

All code follows these naming and formatting rules.

| Element | Convention | Example |
|---------|-----------|---------|
| Class/Interface/Type | PascalCase | `WhoisProvider`, `ScoringEngine`, `DomainCandidate` |
| Enum values | PascalCase | `Verdict.Buy`, `Stage.DnsPrefilter` |
| Function/Variable | camelCase | `evaluateDomain()`, `suggestedBuyMax` |
| Constant (primitive literal) | UPPER_SNAKE_CASE | `DEFAULT_CONFIDENCE_THRESHOLD`, `RENEWAL_COST_EUR` |
| File name | kebab-case | `whois-provider.ts`, `scoring-engine.ts` |
| Test file | `.test.ts` suffix | `scoring-engine.test.ts` |
| Directory name | kebab-case | `providers/`, `scoring/` |
| Private class member | `#` prefix | `#apiKey`, `#weights` |
| Interface name | no prefix/suffix | `WhoisProvider`, `ScoringConfig` (not `IWhoisProvider`) |

- Use explicit exports (`export function` / `export class`) over `export default`
- Barrel exports via `index.ts` re-exporting public API only
- No `any` type; use `unknown` with type guards for unsafe values
- Async functions return `Promise<T>`, not void promises
- Error classes extend `Error` with `code: string`, `context: Record<string, unknown>`, `cause?: Error`

---

## 4. Testing Standards

Every code change MUST include tests. Coverage minimum: 70% line coverage.

| Test Type | Proportion | Scope | Run Frequency |
|-----------|-----------|-------|---------------|
| Unit | 80% | Single function/class in isolation | Every commit |
| Integration | 20% | Module interactions with real SQLite/test doubles | Every PR |

### Rules
- **Mock at module boundaries**: Mock provider interfaces, not HTTP calls
- **Test behavior, not implementation**: Assert on scores and verdicts, not internal computations
- **Naming convention**: `describe/it` blocks describing scenario and expected outcome
- **Arrange-Act-Assert**: Every test follows the AAA pattern
- **Deterministic**: No test depends on external network, time, or random values without seeding
- **Scoring tests MUST include**: at least one "good" domain should score high, at least one "bad" domain should score low, and the engine must never give a buy recommendation for a known domain flaw (hyphen-heavy, numeric-only, etc.)

---

## 5. Error Handling Patterns

### Typed error hierarchy
```
DominusError (base)
  ├── ProviderError
  │   ├── DnsLookupError
  │   ├── RdapError
  │   ├── WhoisError
  │   ├── TrademarkApiError
  │   └── KeywordApiError
  ├── ScoringError
  │   ├── WeightConfigError
  │   └── SignalComputationError
  ├── PipelineError
  │   ├── StageSequenceError
  │   └── CandidateRejectedError
  ├── PortfolioError
  │   ├── DuplicateDomainError
  │   └── RenewalClockError
  └── DatabaseError
      ├── MigrationError
      └── QueryError
```

### Error contract
Every error MUST carry:
- `code`: Machine-readable error code (e.g., `DNS_LOOKUP_FAILED`, `TM_API_UNAVAILABLE`)
- `message`: Human-readable description
- `context`: Structured key-value data (domain name, stage, provider)
- `cause`: Wrapped original error (if any)

### Recovery rules
- Retry transient provider errors (network, rate limit) with exponential backoff + jitter — max 3 retries
- Fail fast on permanent errors (invalid domain format, auth failure) — do not retry
- Provider unavailability MUST NOT block the pipeline for other candidates — log the error, mark the candidate as `unscored`, and continue
- Scoring computation errors MUST fail the entire candidate evaluation (partial scores are misleading)

---

## 6. Security Compliance Checklist (Single-User Context)

Every implementation MUST pass this checklist:

- [ ] All SQLite queries use parameterized statements; zero string concatenation
- [ ] No API keys, tokens, or credentials in code, config files, or logs
- [ ] Provider API keys stored in environment variables or `.env` file (gitignored)
- [ ] Input domain names validated against DNS name format rules before any provider call
- [ ] CSV imports validated for schema compliance before processing
- [ ] File paths for SQLite database, CSV imports use safe path resolution (no directory traversal)
- [ ] Dependencies scanned for known vulnerabilities before addition
- [ ] SQLite WAL mode enabled safely (no concurrent writer issues in single-user mode)

---

## 7. Workflow Integration

### Relationship with other skills

| Skill | Role in DOMINUS workflow |
|-------|--------------------------|
| `impl-scaffold` | Creates new modules following the module structure in §2 |
| `preflight` | Enforces these principles via diff audit before git push |
| `github-workflow` | Manages branching and commits; preflight must pass before push |
| `adr` | Documents architectural decisions that affect these principles |

### Phased delivery alignment

The roadmap in §10 of the vision document maps to these phases:

| Roadmap Phase | Modules affected | Architecture notes |
|---------------|-----------------|-------------------|
| Phase 0 (manual) | — | No code yet; validate scoring logic on paper |
| Phase 1 (MVP sieve) | `pipeline/`, `scoring/`, `db/`, `providers/` (DNS, RDAP) | Stages 2-3-4 only; no trademark or portfolio yet |
| Phase 2 (legal + portfolio) | `trademark/`, `portfolio/` | Add stages 5 and 7 |
| Phase 3 (generators) | `providers/` (keyword, comps), `cli/` or `frontend/` | Brandable generator, closeout import |
| Phase 4 (future) | — | Only when budget and portfolio justify it |

---

## 8. Non-negotiable Rules

- **All provider abstractions MUST be behind interfaces.** Never hardcode a specific API client into the scoring engine or pipeline orchestrator.
- **The trademark gate is never optional.** No buy recommendation without a passing trademark check.
- **The scoring engine must be conservative.** When in doubt, underestimate. Overestimating destroys capital.
- **Renewal cost is tracked from day one.** A domain without a renewal clock is a bug.
- **No paid API is allowed.** Every provider implementation must be free/public/self-hosted.
- **All identifiers, comments, and documentation must be in English.**
