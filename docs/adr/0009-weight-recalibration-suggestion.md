# ADR-0009: Weight recalibration suggestion with manual approval

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-06 |
| **Authors** | DOMINUS team |
| **Deciders** | DOMINUS team |
| **Supersedes** | N/A |
| **Relates to** | ADR-0007 (backtest_signals), ADR-0008 (backtest engine) |
| **Project** | DOMINUS |

## Context

ADR-0007 and ADR-0008 give us a backtest report: for every sold outcome
we know the engine's prediction and the realised sale price, with
point-in-time correctness. The next obvious step is to *use* that data
to tune the engine's weights.

Vision §6 says weights are "tuned manually against real comparable
sales" and §9 says the engine "improves as outcomes are recorded". So
this is the loop vision promised. But Principle 5 of the architecture
guardian is unambiguous: "the scoring engine must be conservative. When
in doubt, underestimate. Overestimating destroys capital."

These two statements together imply that any auto-application of weight
changes is forbidden: the engine may *suggest*, but a human must
*approve*. The cost of an unapproved bad weight is real money
(buy_max is no longer the right ceiling → portfolio bleeds cash on
overpriced acquisitions).

We also have a sample-size problem. At realistic project scale
(tens of sold outcomes per year), a Pearson correlation has
questionable statistical power. Spearman is more robust but is
non-trivial to implement correctly from scratch. The suggestion
algorithm must work on tiny samples without producing false
confidence.

## Decision Drivers

1. **Two-gate activation.** The engine must not auto-apply. The
   suggester writes a file; the operator activates it via `.env`.
2. **Conservative safety rails.** Every delta must be capped, the
   resulting weights must renormalise to 1.0, and a small sample
   must produce a "hold" verdict (not a forced recommendation).
3. **Interpretability.** The operator must understand *why* the
   suggester proposes what it proposes. A correlation coefficient
   on 6 data points is opaque; a "high-signal sold for €X more than
   low-signal" comparison is not.
4. **Auditability.** Every applied suggestion lands in a JSON file
   with `generatedAt` and `sampleSize` so future readers know what
   data drove the change.
5. **No new dependencies.** Stdlib only — no `simple-statistics`, no
   math libraries, no ML.

## Considered Options

### Option A: "High vs low" lift comparison with manual approval (CHOSEN)

For each signal, split the sample into "high" (score ≥ 0.5) and
"low" (score < 0.5). Compute the lift = mean(realised) in high
minus mean(realised) in low. If both buckets have n ≥ 2 and
|lift| ≥ €50, propose ±0.02 (capped at ±0.05). Otherwise hold.

After raw deltas are computed, renormalise so the four suggested
weights still sum to 1.0 — this prevents the "drift into a regime
the operator didn't approve" failure mode where individual deltas
look small but the overall weight envelope shifts unexpectedly.

The CLI exposes this as `dominus backtest suggest-weights [--apply]`.
`--apply` writes `data/weights-override.json`. The engine reads
that file only when `SCORING_WEIGHTS_OVERRIDE` is set in `.env`.

**Advantages:**
- Operationally honest. The operator can read the rationale for
  every suggestion in one sentence: "high-intrinsic sold for
  €400 more on average → +2% weight."
- Works on tiny samples. We require n ≥ 5 to do *anything*; we
  require n ≥ 2 in each bucket to make a per-signal suggestion.
- No statistics library needed. A `mean()` and a couple of
  thresholds are enough.
- Two-gate activation enforces Principle 5. Writing a file does
  not change the engine's behaviour. The operator must also
  touch `.env` to activate.
- Renormalisation guarantees the override file's weights sum to
  1.0, preventing the "weights are no longer a partition of
  unity" bug.

**Disadvantages:**
- Not as statistically rigorous as a proper correlation test. A
  high-signal/low-signal split is a binary discretisation; it
  loses information.
- The €50 lift threshold is a magic number. We chose it because
  the typical `suggested_buy_max` in the portfolio is €200-€500;
  a €50 lift is one quarterly renewal cost and is meaningful at
  this scale.
- Per-signal deltas are coarse (±0.02 steps). The first calibration
  round will rarely converge to the "true" weights; it nudges.

**Cost Implications:** Trivial. No new dependencies. ~150 lines
plus 8 unit tests.

**Risk Assessment:** Low. The two-gate activation is the load-bearing
piece — without it, this is exactly the "engine auto-applies
weight changes" anti-pattern. The validation in `loadWeights()` is
the second safety net: a malformed override file falls back to
defaults with a stderr warning, not a crash.

---

### Option B: Spearman rank correlation per signal

Compute the Spearman ρ between (signal score, realised sale price)
across all backtest signals. Suggest a delta proportional to ρ.

**Advantages:**
- Statistically principled. Spearman is the right test for
  ordinal/discrete signal scores and continuous sale prices.
- Captures monotonic relationships, not just "high > low".

**Disadvantages:**
- Spearman is not trivial to implement correctly from scratch
  (tied ranks, ties across signals, finite-sample correction).
- Even on 30 data points, ρ = 0.4 is at the edge of statistical
  significance. The suggester would still need a "hold when
  uncertain" path.
- More complex = harder to audit. A reviewer has to trust the
  implementation, not just read the rationale.

**Cost Implications:** Moderate. ~50 lines for the algorithm,
~30 lines of test fixtures for tied ranks, no new dependencies
but more surface to maintain.

**Risk Assessment:** Medium. A bug in the correlation code would
silently mis-tune weights. The "high vs low" comparison has no
such failure mode — its output is directly inspectable from
the data.

---

### Option C: Bayesian update with a strong prior

Treat the current weights as a prior and update from the data
with a likelihood function derived from the calibration buckets.
Produce a posterior distribution of weights and use its mean as
the suggestion.

**Advantages:**
- Conceptually the right framework for "small data, prior knowledge,
  update as we learn".
- Naturally handles the "hold when data is weak" case (posterior
  collapses to prior when data is uninformative).

**Disadvantages:**
- Overkill at this scale. The operator has ~10-50 outcomes; a
  Bayesian posterior is not more useful than a point estimate
  + a clear rationale.
- Adds a statistical concept the operator must learn to interpret.
- Implementing the likelihood requires picking a noise model,
  which is itself a modeling decision.

**Cost Implications:** High. New conceptual surface, ~200 lines
of code, harder tests.

**Risk Assessment:** Medium. The complexity is not justified by
the sample size.

## Decision

**Chosen option: Option A — "high vs low" lift comparison with
two-gate manual approval.**

The combination of (a) a simple, auditable algorithm and (b) a
two-gate activation (file write + `.env` setting) is the right
trade-off for a personal-use, conservative tool. The
"high-intrinsic sold for €X more" rationale can be explained in
one sentence and verified by reading three rows of the
`backtest_signals` table.

We rejected Spearman (Option B) because the implementation cost
is not justified at our sample sizes, and we rejected Bayesian
update (Option C) for the same reason. Both options also
increase the cognitive load on the operator, who is the only
person allowed to approve the change.

The two-gate activation is the load-bearing safety rail. Writing
`data/weights-override.json` is the *first* gate; setting
`SCORING_WEIGHTS_OVERRIDE` in `.env` is the *second*. Both must
be flipped before the engine reads the file. The
`loadWeights()` helper validates the file at startup and falls
back to defaults with a stderr warning on any failure — the
engine never crashes the pipeline because of a bad override
file.

## Consequences

### Positive
- **Auditable calibration loop.** Every applied suggestion is
  recorded in a JSON file with `generatedAt` and `sampleSize`.
  A year from now, "why are weights 0.32/0.30/0.28/0.10?" is
  answerable.
- **Operator stays in control.** The suggester is read-only with
  respect to the engine's configuration. Nothing changes
  without an explicit `.env` edit.
- **Conservative defaults.** The `MIN_LIFT_EUR = 50` threshold
  and `MIN_SAMPLE_SIZE = 5` floor mean a new portfolio with
  3 sold outcomes sees "hold, insufficient sample" instead of
  forced weight changes.
- **Self-healing on bad input.** `loadWeights()` validates
  the file and falls back to defaults. A typo in the JSON
  cannot brick the engine.

### Negative
- **Two steps to activate.** The operator must run
  `--apply`, then edit `.env`. A single-step command would be
  friendlier but is exactly the auto-apply anti-pattern.
- **Coarse granularity.** ±0.02 steps mean the first calibration
  round rarely converges to the "true" weights. Multiple rounds
  over years are expected.
- **No statistical significance test.** The "high vs low"
  comparison does not compute a p-value. On 5 data points this
  is the right call; on 500 data points it might be wrong.
  We document this as a known limitation.

### Compliance and Security Implications
- No new external calls, no new dependencies.
- The override file is read from a path the operator
  configures. We restrict the file-write to paths inside
  `./data/` to prevent the CLI from being tricked into writing
  to a sensitive location if `SCORING_WEIGHTS_OVERRIDE` is
  misconfigured.
- No PII, no credentials, no API keys in the override file —
  it contains four numbers and a timestamp.

### Migration and Monitoring Plan
- **Migration:** The schema is unchanged. The CLI gains one
  subcommand and one new env var. Forward-only.
- **Rollout:** Available the moment the code is merged. The
  first call on a fresh database returns
  "hold, insufficient sample" — no surprise.
- **Monitoring:** The `weights-override.json` file's
  `sampleSize` field tells the operator how much data drove
  any active weights. A "small N override" warning is the
  natural next feature.
- **Rollback:** Revert the commit. The override file becomes
  inert because the loader code is gone with the commit.

### Validation
- Unit tests in `weight-suggester.test.ts` cover: small
  sample → hold, predictive signal → +delta, anti-predictive
  signal → -delta, renormalisation, small-bucket → hold,
  ±0.05 cap, custom weights config, default weights config.
- Unit tests in `weights-loader.test.ts` cover: undefined
  path → defaults, missing file → defaults + warning, bad
  JSON → defaults + warning, missing key → defaults,
  out-of-range value → defaults, bad sum → defaults, valid
  file → accepted.
- Integration validation: a synthetic portfolio of 6
  outcomes (3 high-intrinsic, 3 low-intrinsic, 1000 EUR
  price difference) should produce a `+0.02` intrinsic
  delta and a `hold` verdict for the other three signals.
- Production validation: the operator's first
  `dominus backtest suggest-weights` on the real portfolio
  should produce a sensible report that they can defend
  in one sentence per signal.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision in `dominus-product-vision.md`.
Template: `/home/aledio/Documents/Project/dominus/.claude/skills/adr/template.md`.*
