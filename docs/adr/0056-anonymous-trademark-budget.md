# ADR-0056: Anonymous Trademark Budget Isolation

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0006, ADR-0030, ADR-0033, ADR-0043, ADR-0041 |
| **Project** | DOMINUS |

## Context

The trademark gate (ADR-0006) is mandatory: every candidate must pass the
USPTO/EUIPO check before any buy recommendation. On the public namespace
(ADR-0030) every anonymous valuation runs the same gate through
`AnonScoringService`, drawing from the **same** per-process USPTO/EUIPO rate
limit buckets as pipeline runs.

Two problems follow from sharing one budget:

1. **Starving the pipeline.** The public namespace is internet-facing and
   per-IP rate limited (ADR-0043), but aggregated anonymous traffic is
   unbounded. A valuation spike (a post going viral, a scraping wave) can
   drain the shared USPTO/EUIPO tokens for minutes at a time, delaying the
   trademark stage of pipeline runs — the revenue-critical path. In the
   multi-process Cloud deployment (ADR-0033) each process holds its own
   in-memory budget, so three processes can *multiply* anonymous demand by
   the replica count.
2. **Fail-closed leakage onto the public surface.** The trademark gate fails
   closed by design (ADR-0006): its deadline and circuit breakers produce an
   `unverified` verdict and strip the buy signal. That is correct for the
   pipeline, but on the public namespace an exhausted shared budget converts
   a *capacity* problem into degraded *quality* for visitors — without any
   signal telling the operator why.

The public namespace needs its own, bounded allowance for trademark checks:
anonymous traffic must be *contained* by design, not by luck, and the
operator must see when the containment engages.

## Decision Drivers

1. **Trademark gate is non-negotiable (ADR-0006)** — every candidate, public
   or pipeline, keeps a mandatory trademark verdict; the public surface may
   never bypass the gate.
2. **Pipeline integrity** — anonymous traffic must never delay or starve
   pipeline trademark checks (shared budget = hidden coupling).
3. **Public UX + cost discipline** — bounded wait, bounded provider spend;
   degradation must be graceful, visible to operators, and cheap (community
   edition stays at €0).
4. **Zero-cost community parity** — with defaults off, the community edition
   behaves byte-identically to today; enabling the budget costs nothing.
5. **Operator control** — the budget parameters (capacity, refill, acquire
   deadline) must be configurable and observable via existing telemetry.

## Considered Options

### Option A: Dedicated fail-open budget gate (chosen)

A dedicated token bucket (`anon-trademark` Redis namespace in Cloud, in-memory
otherwise) guards trademark checks initiated by anonymous valuations. The
acquire is bounded by `ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS`; on timeout (or
limiter error) the valuation **fails open** to an `unverified` verdict — the
provider is never touched and the buy signal is stripped (ADR-0006). Feature
disabled by default (`ANON_TRADEMARK_BUDGET_ENABLED=false`).

**Advantages:**
- Anonymous demand is isolated: no path from the public surface to the
  pipeline's USPTO/EUIPO tokens, in any process topology.
- Provider cost is hard-bounded per interval (`TOKENS × replicas`); worst
  case is 2 USPTO + 2 EUIPO checks per second on defaults.
- Fail-open keeps the public surface responsive — the price is an
  `unverified` verdict, exactly the same output the gate already produces on
  provider errors, so public semantics are unchanged, just more frequent
  under load.
- Distributed namespace in Cloud shares one budget across api/worker/
  scheduler replicas (ADR-0041 fair-share pattern), so a fleet cannot
  multiply anonymous demand.
- Telemetry: `dominus_anon_trademark_{hits,blocked}_total` makes
  containment observable; blocked = visitors got `unverified` solely due to
  budget pressure.

**Disadvantages:**
- A new configuration surface (4 env vars) with a new default.
- Under sustained anonymous demand, visitors see `unverified` verdicts that
  are capacity artifacts, not trademark reality — the operator must raise
  the budget if they want public quality back.
- Fail-open is a deliberate softening of the gate's semantics for this one
  surface; it must never extend to the pipeline.

**Cost Implications:** ~1 day (gate + service wiring + telemetry + docs). No
infra or API cost.

**Risk Assessment:** Low — feature is off by default; when on, the pipeline's
fail-closed trademark semantics (ADR-0006) are untouched by construction
(separate budget, separate code path).

---

### Option B: Shared budget with public priority queue

Anonymous valuations wait behind pipeline checks in the shared USPTO/EUIPO
buckets (priority queuing), no separate budget.

**Advantages:**
- Single budget to reason about; no new config.

**Disadvantages:**
- The shared budget is per-process; a scraping wave still stalls pipeline
  checks until the wait timeout fires (and then *drains* provider calls on
  the way out — worse).
- No cost containment: anonymous traffic can still spend unlimited provider
  calls, just at lower priority.
- Queue-full rejections (RateLimiterQueueFullError) on the public surface
  surface as hard errors instead of graceful degradation.
- No operator signal distinguishing "gate failing" from "budget pressure".

**Cost Implications:** ~0.5 day. No infra cost.

**Risk Assessment:** Medium-high — introduces a priority mechanism into the
shared limiter used by the pipeline; the isolation the problem actually needs
is not achieved.

---

### Option C: Fail-closed budget (deny → error)

Like Option A but a denied budget returns an HTTP error to the anonymous
caller instead of an `unverified` verdict.

**Advantages:**
- Simplest semantics: no budget, no valuation.

**Disadvantages:**
- Converts capacity pressure into hard failures on the public surface
  (5xx storm under load — the failure mode public endpoints must avoid).
- The trademark gate's own behaviour on provider failure is `unverified`,
  not error; Option C introduces an inconsistent failure mode for a
  capacity problem.
- Worse UX and worse optics than a verdict that explains itself.

**Cost Implications:** ~0.5 day. No infra cost.

**Risk Assessment:** Medium — public availability degrades into error
responses exactly when traffic is highest.

## Decision

**Chosen option: Option A — dedicated fail-open budget gate.**

The public namespace gets its own trademark-check allowance with a bounded
acquire and fail-open semantics. This is the only option that achieves the
three non-negotiables at once: the pipeline's trademark capacity is isolated
by construction (no code path from anonymous traffic to the pipeline's
tokens), anonymous provider spend is hard-bounded, and the public surface
degrades into the same `unverified` verdict the gate already produces on
provider errors — no new failure mode.

The gate wraps a `RateLimiterLike` (in-memory `RateLimiter`, or
`RedisRateLimiter` on the `anon-trademark` namespace in Cloud) and exposes a
single `tryAcquire()` that never throws: grant → run the gate; denial →
`unverified`, provider untouched. Disabled by default so the community
edition ships byte-identical behaviour; operators who want public quality
under load raise `ANON_TRADEMARK_RATE_LIMIT_TOKENS` or disable the budget.

## Consequences

### Positive
- Anonymous valuations can never starve pipeline trademark checks, in any
  process topology (shared Cloud namespace via Redis).
- Provider spend from the public surface is bounded by configuration
  (2 tokens/s default); a traffic spike costs budget tokens, not money.
- Fail-open matches existing public semantics: an `unverified` verdict with
  `suggestedBuyMax` stripped is already the ADR-0006 behaviour on provider
  failure — visitors see the same quality degradation, not a new error.
- New Prometheus counters make containment visible: a jump in
  `dominus_anon_trademark_blocked_total` is a capacity signal with a config
  knob attached.
- ADR-0006 pipeline semantics untouched: the pipeline's trademark checks
  keep the shared buckets, fail-closed, as before.

### Negative
- Visitors under sustained anonymous demand may receive `unverified`
  verdicts that are capacity artifacts (mitigated by raising the budget).
- 4 new env vars and a new component (`AnonBudgetGate`) to learn.
- Fail-open is surface-specific by design; future maintainers must not
  extend it to the pipeline (the code path separation enforces this: the
  gate exists only inside `AnonScoringService`).

### Compliance and Security Implications
- None. No new data flows; no new attack surface — the budget adds a rate
  limit, it removes none. Public endpoints keep their existing per-IP
  limits (ADR-0043).

### Migration and Monitoring Plan
- Defaults off: existing deployments change nothing; enabling is a 1-line
  env change (`ANON_TRADEMARK_BUDGET_ENABLED=true`).
- Metrics to watch after enabling: `dominus_anon_trademark_hits_total`
  (rate of public gate checks), `dominus_anon_trademark_blocked_total`
  (share failing open — keep near 0; raise
  `ANON_TRADEMARK_RATE_LIMIT_TOKENS` if it grows), pipeline trademark stage
  latency (should be unaffected, by design).
- Rollback: set `ANON_TRADEMARK_BUDGET_ENABLED=false` — restores prior
  behaviour instantly.

### Validation
- Unit tests: gate grants/denies/fails open on queue-full, stall and limiter
  error; service returns `unverified` without touching the provider on
  denial; telemetry callback fires per attempt; config defaults/overrides;
  factory builds in-memory/Redis/disabled variants.
- Full backend suite (2241 tests) green with defaults off — community
  behaviour byte-identical.
- Timeline: 1 release cycle in Cloud before judging the default budget.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*
