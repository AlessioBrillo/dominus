# ADR-0010: Portfolio rescore bridge — why DNS/RDAP are bypassed on owned domains

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted (retrospective) |
| **Date** | 2026-06-06 |
| **Authors** | DOMINUS team |
| **Deciders** | DOMINUS team |
| **Supersedes** | N/A |
| **Relates to** | ADR-0007, ADR-0008, ADR-0009 |
| **Project** | DOMINUS |

## Context

`dominus portfolio rescore` (introduced in PR #5) re-evaluates every
entry in the operator's portfolio against the current scoring engine
and the trademark gate. It then refreshes verdicts. Without it, the
`currentScore` column on every portfolio entry was always 0, and the
drop verdict engine (which depends on `currentScore`) was marking
every domain within the renewal horizon as `Drop` — a false positive
that would have wiped a perfectly good portfolio.

The rescore is implemented in `PortfolioRescoreService`. It iterates
over portfolio entries, runs the scoring engine and the trademark
gate on each, and persists the calibrated 0-100 score and suggested
list price. Then `PortfolioManager.refreshVerdicts()` is called.

The decision recorded here is the *deliberate choice* to skip the DNS
pre-filter and RDAP confirmation stages for owned domains. This is
not an oversight — the rescore is intentionally a 2-stage process
(Scoring + Trademark Gate), not a 5-stage one.

## Decision Drivers

1. **DNS pre-filter would drop every owned domain.** The portfolio
   is by definition the set of domains the operator has *bought*,
   which means they are *registered*. Running `dns.resolve()` on
   them is wasted work that always returns "registered".
2. **RDAP confirmation adds no new information.** It would just
   re-confirm the registrar the operator already paid. The only
   information RDAP could add is a new expiry date or transfer
   status, both of which the operator tracks via `portfolio_entries`.
3. **Stages 1 (generation) and 2-3 (DNS/RDAP) are not applicable
   to inventory you already hold.** Those stages exist to filter
   a candidate *set* down to a buyable *shortlist*. The portfolio
   is already a buyable set; filtering is a no-op.
4. **Stages 4 (scoring) and 5 (TM gate) ARE still run.** Keyword /
   comps data may have drifted; the engine's weights may have been
   retuned; new trademark registrations may have been filed since
   acquisition. These are the legitimate reasons to re-score.
5. **The trademark gate is non-negotiable (Principle 6).** Every
   candidate that reaches a buy recommendation must pass the gate.
   The rescore is the *opposite* flow (we already bought it) but the
   same principle applies: if a portfolio domain is now blocked by
   a new trademark filing, the operator should know.

## Considered Options

### Option A: Re-run the full 5-stage pipeline against owned domains (REJECTED)

Treat each portfolio entry as a "candidate" and run the full
pipeline: generation → DNS → RDAP → scoring → TM gate.

**Advantages:**
- Conceptually uniform: one pipeline, no special cases.

**Disadvantages:**
- DNS pre-filter is a wasted network call — it always drops.
- RDAP confirmation is wasted bandwidth against the same registrar
  that just answered us an hour ago.
- The pipeline would write `CandidateStatus` rows to the candidates
  table for owned domains, polluting that table's semantics.
- The pipeline writes `scoring_runs` rows tied to `candidates.id`,
  but the portfolio's FK is to `portfolio_entries.domain`, not to
  `candidates.id`. We'd need a new join column.
- The pipeline's orchestrator log (`PipelineResult.stageSummary`)
  would be misleading: it would say "0 passed DNS pre-filter"
  which is correct but useless.

**Cost Implications:** More code, more network calls, more
database writes, more confusion.

**Risk Assessment:** Low technical risk (the pipeline works), but
high conceptual cost: a maintenance burden for no real benefit.

---

### Option B: Run only Scoring + TM gate (CHOSEN)

A bespoke 2-stage rescore implemented in
`PortfolioRescoreService` that skips generation/DNS/RDAP and goes
straight to the scoring engine and trademark gate.

**Advantages:**
- Zero wasted network calls. The portfolio is local data, scored
  against local state.
- Conceptually honest: "rescore" and "pipeline run" are different
  operations with different scopes.
- Reuses the existing scoring engine and trademark gate (no
  duplication of business logic).
- The `currentScore` field on portfolio entries is updated in
  one transaction, then `refreshVerdicts()` recomputes verdicts
  in a second pass — the bug we were fixing.

**Disadvantages:**
- Two code paths to maintain (pipeline + rescore). The risk is
  drift: a future change to the scoring engine might be reflected
  in the pipeline but forgotten in the rescore. We mitigate by
  *constructing* the rescore around the same `ScoringEngine` and
  `TrademarkGate` instances the pipeline uses.
- Slightly inconsistent with vision §5's table, which lists
  "Stage 4: Scoring" and "Stage 5: Trademark Gate" as a 2-stage
  subset of the 5-stage pipeline. We accept this: the table
  describes the *purpose* of those stages, not the fact that they
  are tied to stages 1-3.

**Cost Implications:** Trivial. ~150 lines of code, fully tested.

**Risk Assessment:** Low. The risk of drift between pipeline and
rescore is real but bounded — both share the engine and gate, so
the only drift surface is the per-entry orchestration, which is
covered by tests in `portfolio-rescore-service.test.ts`.

---

### Option C: Refactor the pipeline to be configurable (skip-stages)

Make the 5-stage pipeline accept a "skip stages [1,2,3]" flag and
use it from the rescore command.

**Advantages:**
- One code path.
- Stage ordering is enforced in the orchestrator, not duplicated.

**Disadvantages:**
- Adds a flag to a working orchestrator for a niche use case.
- The orchestrator's invariants (each stage depends on the previous)
  still hold — it's just that some stages are no-ops. The
  conceptual cost is "we now have a pipeline that sometimes is
  not a pipeline".

**Cost Implications:** Lower code volume, higher conceptual cost.

**Risk Assessment:** Low. Just a worse trade-off.

## Decision

**Chosen option: Option B — bespoke 2-stage rescore.**

The rescore is a different operation from a pipeline run. It
operates on a different input (owned portfolio entries, not
candidate keywords) and produces a different output (updated
`portfolio_entries` rows, not `candidates` + `scoring_runs`). The
cleanest implementation is a separate service that shares the
scoring engine and trademark gate but not the orchestrator.

This decision was made when the rescore was introduced in PR #5
but was not recorded in an ADR. ADR-0010 closes that documentation
gap so the next maintainer understands why `PortfolioRescoreService`
exists alongside `PipelineOrchestrator` instead of being folded
into the latter.

## Consequences

### Positive
- **The drop verdict bug is fixed.** Before PR #5, every portfolio
  entry within the renewal horizon was marked Drop because
  `currentScore` defaulted to 0. The rescore populates `currentScore`
  and `refreshVerdicts()` then makes the right call.
- **Trademark re-validation happens for owned domains.** If a
  new mark is registered that conflicts with an owned domain,
  the rescore surfaces it. The operator can choose to drop,
  rebrand, or defend.
- **Net-new signal for the backtest engine.** Each rescore
  updates `scoring_runs` with the new `scored_at`, so a portfolio
  domain sold months later will join correctly in the
  point-in-time lookup (ADR-0008) — its scoring snapshot is the
  *most recent* rescore, not the original acquisition-time
  score.
- **Conceptual clarity.** "Run the pipeline" and "rescore the
  portfolio" are now clearly two different operations with two
  different commands (`dominus run` and `dominus portfolio rescore`).
  The operator's mental model matches the code.

### Negative
- **Two code paths.** Future changes to scoring logic need to
  be tested in both. We mitigate by sharing the engine and gate
  instances, so the duplication surface is the orchestration
  only.
- **No bulk-write atomicity today.** The rescore writes
  per-entry in a loop. A 1000-domain portfolio takes 1000
  small transactions. At realistic scale (tens of domains) this
  is fine; a future "scale to 10k domains" effort will need to
  refactor this into a single transaction.

### Compliance and Security Implications
- The rescore still runs the trademark gate (Principle 6). No
  buy recommendation is produced for an owned domain, but the
  gate's verdict is recorded in the rescore summary and exposed
  via `dominus portfolio rescore --verbose` and the REST
  `/api/portfolio/rescore` endpoint.
- The rescore does not write to `candidates` or `scoring_runs`
  by default — it only updates `portfolio_entries`. This keeps
  the candidate and scoring_run history clean and means a
  rescore never pollutes the pipeline's audit log.
  (Note: the original `PortfolioRescoreService` in PR #5 did
  not write to `scoring_runs`; only the application-level
  scoring in `cli run` does that.)

### Migration and Monitoring Plan
- **Migration:** None. The rescore is a new code path; it
  operates on existing tables.
- **Rollout:** Available since PR #5 was merged.
- **Monitoring:** The rescore prints its `totalDurationMs` and
  per-domain `RescoreOutcome` for the operator to inspect. An
  unexpected large duration (>10s for 50 domains) is the
  signal that something is wrong (e.g. a TM provider is
  rate-limiting).
- **Rollback:** The verdicts are recomputed from
  `currentScore` and `renewal_date`. If the rescore produces a
  bad verdict, the operator can revert by setting `currentScore`
  to the previous value or by running `dominus portfolio verdicts`
  again after fixing the score.

### Validation
- Unit tests in `portfolio-rescore-service.test.ts` cover the
  happy path, the trademark gate, error containment, and the
  calibrated 0-100 score.
- Integration tests in `portfolio-route.test.ts` exercise the
  rescore through the REST API.
- Production validation: a portfolio of 5 domains with known
  verdicts (some Keep, some Drop) should produce the same
  verdicts after a rescore, modulo the calibration delta from
  the current engine weights.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision in `dominus-product-vision.md`.
Template: `/home/aledio/Documents/Project/dominus/.claude/skills/adr/template.md`.*
