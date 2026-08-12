# ADR-0055: Evidence-Anchored expectedValue

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-12 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0020, ADR-0008, ADR-0006 |
| **Project** | DOMINUS |

## Context

The scoring engine computes `expectedValue = weightedScore × baseMarketValueEur`
where `baseMarketValueEur` defaults to 500 and the market signal saturates at
`score = 1` for any median comparable sale ≥ `highValue` (10,000). The
combination means **no domain can ever be valued above €500** — a domain whose
comparables sell at €200,000 produces the same expected value and buy
recommendation as one with no sales history at all that merely scores 1.0 on
the name-quality signals.

The `suggestedBuyMax` was additionally clamped by `BUY_MAX_ABSOLUTE_CAP`
(default 500), so the maximum possible buy recommendation was €250 regardless
of evidence. The engine's own documentation admitted the cap "flattens the
market signal above ~€500" (`types/score.ts`).

This flattening is not conservatism (ADR-0002: never be *more generous* than
the evidence) — it is a hard ceiling that discards the strongest evidence the
engine collects: the comparable sales median. Every domain above the ceiling
receives the identical recommendation, making the tool useless for exactly the
mid/high-end segment where margins exist.

Two secondary defects surfaced during the same hardening pass:

1. **Checkpoint resume replays stale verdicts.** A run resumed from a
   `pipeline_checkpoints` row written by a different binary version (or simply
   old: DNS/RDAP verdicts go stale) replayed candidate verdicts computed under
   older logic — silently violating ADR-0040 parity.
2. **The Redis heartbeat renewed the wrong lock.** The lock heartbeat ran in
   a `setInterval` callback outside the caller's `runWithTenant` scope, so it
   renewed `pipeline_run:default` while the run held `pipeline_run:<tenant>`,
   then aborted every tenant's controller after 3 failures — a cross-tenant
   outage on the cloud path.

Both are documented in the hardening branch; this ADR governs the value model.

## Decision Drivers

1. **Conservatism doctrine (ADR-0002)** — the engine must never recommend more
   than the evidence supports; "more generous than commercial appraisals" is
   forbidden.
2. **Decision utility** — a tool whose ceiling truncates every recommendation
   at €250-500 is a closeout scalper by construction, not a decision-support
   engine; buyers of 4-5 figure domains get no signal.
3. **Backtest stability (ADR-0008)** — the tuning loop tunes *weights*, not
   the value scale; a change that alters `expectedValue` must not require a
   re-tune of signal weights.
4. **Zero-cost community parity** — the fix must work identically with no
   paid data: no market data ⇒ behaviour must remain exactly as before.
5. **Operator control** — a hard per-deal budget ceiling must remain available
   for operators who want one.

## Considered Options

### Option A: Evidence-anchored value scale (chosen)

`expectedValue = weightedScore × anchorEur` where
`anchorEur = max(baseMarketValueEur, medianSalePrice)` when the market signal
has data, else `baseMarketValueEur`. `BUY_MAX_ABSOLUTE_CAP` default becomes 0
(no ceiling); a positive value still enforces a hard per-deal cap.

**Advantages:**
- Value reflects the strongest evidence (comparables median) instead of
  discarding it; no market data ⇒ byte-identical behaviour to today.
- Weights, thresholds, confidence and `recommended` are untouched — the
  backtest tuning loop (ADR-0008) is unaffected.
- Faithful to ADR-0002: the median is evidence, never generosity; the
  confidence gate (≤ 0.8) still derates bids.
- Operators keep an absolute ceiling via one env var.

**Disadvantages:**
- Domain with a single inflated comparable can inflate the anchor — bounded
  by the existing density adjustment (weight scaling on sparse data) and by
  `suggestedBuyMax = expectedValue × 0.5`.
- Monetary outputs (`expectedValue`, `suggestedListPrice`, bids) change for
  market-data runs; dashboards/consumers see higher numbers than before.

**Cost Implications:** ~0.5 day (engine + config + tests). No infra or API cost.

**Risk Assessment:** Low — the decision path (`recommended`) is unchanged; only
the monetary scale moves. Rollback is a config revert (`BUY_MAX_ABSOLUTE_CAP=500`).

---

### Option B: Logarithmic tier scaling

`expectedValue` is computed via a log-scaled mapping of the median
(generous below the ceiling, gentle above).

**Advantages:**
- Value magnitude compresses outliers smoothly.

**Disadvantages:**
- A new free parameter set (tier boundaries) enters the scoring model,
  requiring backtest validation; tuning the tiers is undeveloped work.
- More complex than the problem needs; the *shape* of the curve is not the
  issue — the flat ceiling is.

**Cost Implications:** 2-3 days incl. tier calibration against NameBio data.

**Risk Assessment:** Medium — model behaviour changes across the whole range,
not just above the old ceiling; backtest re-validation required.

---

### Option C: Keep the ceiling, document it

Keep `expectedValue ≤ 500` and document that DOMINUS is a closeout-scalper
tool.

**Advantages:**
- Zero code change.

**Disadvantages:**
- Officially abandons the mid/high-end market instead of fixing the model;
- The strongest signal in the engine stays deliberately unused; every
  above-ceiling domain still gets an identical recommendation.

**Cost Implications:** none.

**Risk Assessment:** High product risk — competitors (Estibot, NameBio
appraisal) answer the entire range; a tool that flatlines at €500 is
uncompetitive in its own market.

## Decision

**Chosen option: Option A — evidence-anchored value scale.**

The value scale must be *derived from evidence when evidence exists*, and
must remain byte-identical when it does not (zero-cost parity, community
edition). The comparable-sales median is the best evidence the engine
collects; deflating it through a €500 ceiling converts intelligence into
noise for every candidate above the ceiling. Option B adds a calibrated curve
that duplicates what the median already says, at tuning cost (ADR-0008) with
no correctness benefit. Option C keeps the product a scalper tool and wastes
the market signal — rejected on decision utility.

The ceiling itself is demoted from a model constant to an operator preference:
`BUY_MAX_ABSOLUTE_CAP` default 0 = uncapped, positive = hard per-deal budget.
Conservatism is preserved through the unchanged gate stack: market-score
saturation at 1.0, the density adjustment scaling sparse comparables, the
confidence derate (`conservative = aggressive × confidence`, cap 0.8), and
`buyMaxRatio = 0.5`.

## Consequences

### Positive
- The engine now distinguishes a €300 closeout flip from a €50k aftermarket
  domain; value tracks evidence.
- Hardened checkpoints (format version + 24h staleness) and the tenant-scoped
  heartbeat ship in the same branch, removing two production traps.
- No backtest re-tune required: `recommended`, weights, thresholds untouched.

### Negative
- Monetary figures change for market-data runs — consumers of
  `expectedValue`/`suggestedListPrice` (dashboard, CLI, portfolio NPV) will
  see numerically larger values.
- A single outlier comparable can lift the anchor — mitigated as documented,
  not eliminated.

### Compliance and Security Implications
- None. No new data flows; no privileged paths.

### Migration and Monitoring Plan
- Defaults change in code; existing deployments that set
  `BUY_MAX_ABSOLUTE_CAP=500` keep the old ceiling (no behavioural break).
- Metrics to watch: distribution of `suggestedBuyMax` across runs (expect a
  long tail above €250 that previously did not exist), and the backtest
  accuracy series (ADR-0008) — it should be unchanged, by design.
- Rollback: set `BUY_MAX_ABSOLUTE_CAP=500` — restores the historical cap.

### Validation
- Unit tests: anchoring with a €200k median yields `expectedValue > 500` and
  `suggestedBuyMax ≤ expectedValue × 0.5`; no-market runs stay ≤ 500.
- Backtest suite runs green on the weight-tuning loop.
- Timeline: 1 release cycle before judging the value distribution.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*