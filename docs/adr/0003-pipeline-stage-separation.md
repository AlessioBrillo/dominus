# ADR-0003: Pipeline Stage Separation

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted (retrospective) |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0001, ADR-0002, ADR-0006, ADR-0010 |
| **Project** | DOMINUS |

## Context

The core workflow of DOMINUS is a pipeline that transforms raw candidate
inputs (keywords, closeout CSV rows, brandable names) into structured buy
recommendations. Each stage in the pipeline performs a distinct operation:
generating candidates, filtering by DNS availability, confirming via RDAP,
scoring, and checking trademarks.

From the outset it was clear that these stages must:

1. **Run in strict order** — each stage depends on the output of the
   previous. DNS-filtered names feed RDAP confirmation; RDAP-confirmed names
   feed scoring; scored names feed the trademark gate. Running out of order
   wastes provider calls or produces invalid results.
2. **Be independently testable** — a change to the trademark matching
   algorithm should not require running DNS lookups to verify.
3. **Be independently replaceable** — swapping the RDAP provider from a
   public HTTP endpoint to a WHOIS port-43 server should not affect the
   scoring stage.
4. **Produce auditable per-stage metrics** — the operator needs to know how
   many candidates were filtered at each stage and how long each stage took.

The pipeline orchestrator is the only component that coordinates stage
execution. Individual stages never call each other.

## Decision Drivers

1. **Sequential dependency** — each stage filters the candidate set. The next
   stage's input is a strict subset of the previous stage's output. Running
   stages out of order would waste compute (scoring before DNS filtering is
   pointless) or produce invalid results (trademark check before registration
   check would waste rate-limited API calls on domains that may already be
   registered).
2. **Testability** — each stage must be testable in isolation with mocked
   providers. Without stage separation, tests would need to set up the entire
   pipeline even for a small change to one signal.
3. **Provider swap** — a stage's internal implementation (Node `dns` vs.
   `dns-prefetch` library, RDAP HTTP vs. WHOIS port-43) must be swappable
   without changing the stage's interface or the orchestrator.
4. **Transparency** — the operator must be able to see, for each pipeline
   run, how many candidates entered stage N, how many passed, and how long
   it took. This is essential for debugging (why did only 3 of 100 candidates
   reach the scoring engine?) and for performance optimisation (which stage is
   the bottleneck?).

## Considered Options

### Option A: Strict Stage Interface + Orchestrator (CHOSEN)

Each stage implements a generic `Stage<I, O>` interface with a single
`process(inputs: I[]): StageResult<O>` method. The orchestrator calls stages
sequentially, threading the `passed` array of each stage into the next.

A `StageResult` contains three fields:
- `passed`: candidates that passed the stage and move to the next.
- `filtered`: candidates filtered by this stage (with reason).
- `stageName` + `durationMs`: metrics for the summary.

**Advantages:**
- Maximum testability: each stage can be instantiated with mock providers and
  tested in a single `describe` block without setting up unrelated stages.
- Maximum replaceability: swapping `DnsPreFilterStage`'s internal DNS provider
  requires changing exactly one constructor argument.
- The orchestrator is a simple sequential loop — five calls, no branching, no
  state machine. It is easy to reason about and test.
- Each pipeline run produces a structured `stageSummary` with per-stage
  metrics, which is persisted to `pipeline_runs` (ADR-0011).

**Disadvantages:**
- The generic `Stage<I, O>` interface requires careful type parameter
  management as stages evolve. The `ScoringStage` produces `ScoredCandidate`
  (with `scoreResult`), while earlier stages produce `DomainCandidate`
  (without `scoreResult`). The orchestrator must track these types.
- Adding a new stage requires: (a) implementing the interface, (b) threading
  it through the orchestrator constructor, and (c) connecting its output to
  the next stage's input. This is more boilerplate than a single monolithic
  function.

**Cost Implications:** Zero monetary cost. ~40 hours to design and implement
the interface, the orchestrator, and the five stages.

**Risk Assessment:** Low. The pattern is well-established in data engineering
and ETL pipelines.

---

### Option B: Monolithic Pipeline Function

A single `runPipeline(input)` function that contains all five stages in
sequence, each calling providers and scoring functions directly.

**Advantages:**
- Less code: no interface, no type parameter threading, no `StageResult` type.
- Faster to write initially.

**Disadvantages:**
- Impossibile to test stages in isolation without running the entire pipeline.
- Impossible to swap providers without editing the monolithic function.
- Per-stage metrics would need to be manually instrumented.
- Adding a new stage means editing the monolithic function, increasing the
  risk of breaking unrelated stages.
- The function would grow to 200+ lines with mixed concerns (DNS lookups,
  RDAP calls, scoring computations, trademark checks).

**Cost Implications:** Zero monetary cost. Cheaper initially, more expensive
over time as the codebase grows.

**Risk Assessment:** Medium-high. The monolithic function becomes a
maintenance bottleneck as the pipeline evolves. Testing requires full
integration setup for every change.

---

### Option C: Pub/Sub Event-Driven Pipeline

Stages communicate via an event bus: each stage subscribes to the previous
stage's events and publishes its own. The orchestrator is replaced by a
message broker (or an in-process EventEmitter).

**Advantages:**
- Loose coupling: stages can be added, removed, or reordered without changing
  the orchestrator.
- Natural parallelism: stages could theoretically process candidates
  concurrently (though DOMINUS does not need this).

**Disadvantages:**
- Dramatically harder to reason about: the candidate flow is no longer a
  linear sequence; it is a graph of event handlers.
- Testing requires setting up the event bus and subscribing test listeners.
- Error handling is distributed: a failure in one stage must propagate back
  to the orchestrator through events, not through a simple try/catch.
- Massive over-engineering for a 5-stage sequential pipeline with a single
  operator.

**Cost Implications:** Zero monetary cost. Significant engineering overhead
for no benefit at DOMINUS scale.

**Risk Assessment:** Low technical risk, but high complexity for no benefit.
The wrong architectural choice.

---

## Decision

**Chosen option: Option A — Strict Stage Interface + Orchestrator**

The rationale is driven by the decision drivers:

1. **Sequential dependency**: The orchestrator calls five stages in strict
   order. Each stage receives the previous stage's `passed` array, ensuring
   that no candidate skips a stage and no stage runs before its input is
   ready. The dependency chain is explicit in the constructor.

2. **Testability**: Each stage is independently testable. The orchestrator
   itself is testable with mock stages. This separation means a change to the
   trademark matching algorithm (ADR-0012) requires only `trademark-gate-stage`
   and `match-detector` tests — not DNS, RDAP, or scoring tests.

3. **Provider swap**: The `DnsPreFilterStage` takes a `DnsProvider` interface
   in its constructor; the `RdapConfirmationStage` takes an `RdapProvider` and
   a `WhoisProvider`. Swapping from the public RDAP provider to a WHOIS-only
   provider requires changing exactly one argument, not editing business logic.

4. **Transparency**: Every `StageResult` carries `passed`, `filtered`,
   `stageName`, and `durationMs`. The orchestrator aggregates these into a
   `stageSummary` that is persisted to `pipeline_runs` (ADR-0011). The
   operator can see, for example, that the DNS pre-filter eliminated 80% of
   candidates in 2.3 seconds.

Option B (monolithic) was rejected because testability and replaceability are
paramount for a system whose core asset (the scoring engine) must be tuned
independently of the availability-checking infrastructure. Option C
(pub/sub) was rejected because it adds complexity without providing any
benefit at DOMINUS scale.

## Consequences

### Positive
- Each stage is a single file implementing a simple interface. New stages can
  be added without touching existing stages.
- The orchestrator is 86 lines with no branching logic — trivial to audit.
- Testing: the orchestrator test creates mock stages and verifies the data
  flow. Stage tests create real stages with mock providers.
- The `stageSummary` provides full visibility into pipeline performance.

### Negative
- Type parameter management: the orchestrator's constructor lists five stage
  parameters with different types. Adding a sixth stage requires adding a
  sixth parameter.
- Stage results carry `domain: string` identifiers that must match across
  stages. A stage that modifies the domain string would break the pipeline.
  (Mitigation: stages never modify the domain field.)
- The `scored` array in the `PipelineResult` is assembled from three sources
  (`scoring.filtered`, `trademark.passed`, `trademark.filtered`), which is
  a subtle data-joining convention. Newcomers to the codebase may miss this.

### Compliance and Security Implications
- The pipeline orchestrator has no external network access — all provider
  calls happen inside the individual stages. The orchestrator is a pure
  coordinator.
- No sensitive data passes through the orchestrator (domains are public
  strings). No data protection concern.

### Migration and Monitoring Plan
- **Migration**: None. This ADR documents the existing design.
- **Monitoring**: The `stageSummary` is persisted to `pipeline_runs` for 180
  days (ADR-0011). The operator can inspect
  `dominus runs show <runId>` to see per-stage metrics.
- **Rollback**: Stage interface changes are backwards-compatible: adding a new
  stage does not break existing stages.

### Validation
- The orchestrator test (`pipeline/__tests__/orchestrator.test.ts`) validates
  all five stages run in order, DNS-filtered names do not reach scoring,
  TM-blocked names appear in `scored[]`, and error verdicts do not recommend.
- Each stage has its own test file with 4-8 tests covering happy path, edge
  cases, and error paths.
- Production validation: `dominus run --closeout-csv <file>` produces a
  `stageSummary` with all five stages populated.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision previously documented in
`dominus-product-vision.md` (v0.2), now superseded by this ADR series.
Template: `docs/adr/template.md`.*
