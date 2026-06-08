# ADR-0002: Scoring Engine Design and Conservatism Principle

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted (retrospective) |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0001, ADR-0007, ADR-0008, ADR-0009 |
| **Project** | DOMINUS |

## Context

The scoring engine is the core asset of DOMINUS. It transforms raw domain
attributes (length, TLD, keyword volume, comparable sales, expiry metadata)
into a structured buy decision with four outputs: `expected_value`,
`confidence`, `suggested_buy_max`, and `suggested_list_price`.

The domain aftermarket is asymmetric: overpricing a domain leads to wasted
capital (buying something worth less than estimated), while underpricing
leads to missed opportunities (not buying something that would have sold).
The asymmetry is not neutral — a single overpriced purchase can exceed the
entire annual budget, while a single missed opportunity costs nothing.

For a budget-constrained operator (~500 EUR), the cost of a false positive
(buy recommendation for a domain that later cannot be resold) is materially
larger than the cost of a false negative (passing on a domain that would have
sold). The engine must therefore be systematically conservative.

Commercial appraisal tools (EstiBot, GoDaddy Domain Appraisal, NameBio
valuation) are known to overprice domains by a factor of 2-10x compared to
realised sale prices, especially for lower-value names. DOMINUS must be
strictly more conservative than these tools.

## Decision Drivers

1. **Loss asymmetry** — the financial impact of overpaying for a domain is
   greater than the financial impact of missing a purchase. The engine must
   be biased toward "no" when uncertain.
2. **Score interpretability** — the operator must be able to understand why a
   domain received a given score. Black-box ML models are unacceptable
   because the operator cannot inspect or override their reasoning.
3. **Weight transparency** — every weight in the scoring formula must be
   inspectable, tunable, and revertible. Automatic weight adjustment is
   forbidden without manual approval.
4. **Measurable accuracy** — the engine's predictions must be backtestable
   against realised sale prices. Without a closed feedback loop, conservatism
   is just guesswork.
5. **No ML** — at the project's scale (tens to low hundreds of outcomes),
   machine learning models would overfit to noise. A heuristic engine with
   manually tuned weights is more robust and more interpretable.

## Considered Options

### Option A: Heuristic Weighted-Sum Engine with 4 Signals (CHOSEN)

A deterministic scoring engine using four independent signals — intrinsic,
commercial, market, expiry — each scored 0-1 and aggregated via a weighted
sum. Weights are loaded from a configurable file; default weights are
hardcoded in `src/scoring/weights.ts`.

**Advantages:**
- Fully interpretable: every signal contribution can be traced and inspected.
- Conservative by design: the `suggested_buy_max` is capped at 50% of
  `expected_value` and further capped by an absolute budget limit (default
  500 EUR).
- Confidence is computed from the number of non-zero signals, not from a
  black-box model. A domain with no keyword or comps data gets low confidence
  regardless of its intrinsic score.
- Weights are manually tuned via the backtest engine (ADR-0008) and require
  explicit operator approval to activate (ADR-0009).
- No training data dependency: the engine works from day one with zero sale
  outcomes. Accuracy improves as outcomes accumulate, but the engine does not
  require them.

**Disadvantages:**
- Weight tuning is subjective until the operator has 20+ recorded sale
  outcomes. Early-stage recommendations may be too conservative or too
  generous in unexpected ways.
- Four signals may miss nuance that a more complex model would capture, such
  as interactions between TLD and keyword relevance (e.g., `crypto.ai` may
  be worth more than the sum of its `crypto` SLD and `.ai` TLD scores).
- Manual weight tuning creates a bus-factor: only the operator who tuned the
  weights can explain why a domain scored the way it did.

**Cost Implications:** Zero monetary cost. ~120 hours to design, implement,
and test the four signals, weight loader, and output computation.

**Risk Assessment:** Low. The heuristic approach is well-understood and
deterministic. The backtest engine provides measurable accuracy feedback.

---

### Option B: ML-Based Regression (Random Forest / XGBoost)

Train a regression model on historical NameBio sales data and apply it to
new candidates.

**Advantages:**
- Can capture non-linear interactions between features.
- No manual weight tuning required — the model learns from data.
- Potentially more accurate at scale (thousands of training examples).

**Disadvantages:**
- Requires thousands of labelled sale outcomes to train a useful model.
  DOMINUS will have tens to low hundreds of outcomes — far too few for a
  reliable model.
- Model interpretation requires SHAP values or similar post-hoc techniques,
  adding complexity.
- Reproducibility requires pinning training data, model version, and
  hyperparameters — significant infrastructure for a single-user tool.
- The model may learn spurious correlations from the training data that are
  invisible until a bad purchase is made.
- Overfitting risk is extreme at DOMINUS dataset sizes.
- The "conservative bias" requirement cannot be hard-coded; it must be
  enforced as a post-processing step, which is fragile.

**Cost Implications:** Zero monetary cost for training data (NameBio data
available). Significant engineering cost for model pipeline, versioning,
reproducibility, and interpretation tooling.

**Risk Assessment:** High at DOMINUS scale. Insufficient training data,
extreme overfitting risk, lack of interpretability, and no architectural
mechanism to enforce conservatism.

---

### Option C: Rule-Based Expert System

A decision tree of manually crafted rules (e.g., "if length > 15, score = 0;
if TLD is `.com`, bonus +0.2; if hyphens present, penalty -0.3").

**Advantages:**
- Maximum interpretability: every rule is explicit and auditable.
- No floating-point weights to tune — rules are boolean or categorical.
- Simple to implement with if/else or a decision-tree library.

**Disadvantages:**
- Brittle: a rule that works for 90% of cases fails catastrophically for the
  remaining 10% (e.g., `best-ai-marketing-cloud.com` would be heavily
  penalised for hyphens despite being a keyword-rich brandable name).
- Impossible to calibrate: the output is a binary or categorical verdict, not
  a continuous score that can be calibrated against realised sale prices.
- No graceful degradation: missing data (no keyword volume, no comps) would
  need explicit rule coverage rather than a natural confidence penalty.
- Maintenance burden grows quadratically with the number of rules.
- The expert system would require the operator to continuously add rules for
  edge cases rather than tuning a small set of weights.

**Cost Implications:** Zero monetary cost. Lower initial effort than Option A,
but higher maintenance cost. Classification accuracy is lower.

**Risk Assessment:** Medium. The brittleness of an expert system makes it
unsuitable for a domain aftermarket where edge cases are common (hyphenated
keyword domains, new gTLDs, brandable non-words).

---

## Decision

**Chosen option: Option A — Heuristic Weighted-Sum Engine with 4 Signals**

The rationale is driven by the decision drivers:

1. **Loss asymmetry**: The weighted-sum engine enforces conservatism at three
   levels: (a) individual signal scoring clamps values to [0, 1], (b) the
   `suggested_buy_max` ratio defaults to 0.5 (buy at half the expected value),
   and (c) a `confidence` threshold (default 0.3) forces a hard pass for
   domains with insufficient data. No ML or rule-based alternative can provide
   this multi-layered conservatism by design.

2. **Interpretability**: The four signal breakdown (`intrinsic`, `commercial`,
   `market`, `expiry`) is exposed in every `ScoreResult`. The operator can
   inspect exactly why a domain scored 0.4 vs 0.8. The backtest report
   (ADR-0008) breaks down MAE by confidence bucket, so the operator knows
   exactly where the engine is over- or under-predicting.

3. **Weight transparency**: Weights are loaded from a configurable file
   (`DEFAULT_WEIGHTS` in `src/scoring/weights.ts` or a JSON override).
   The `backtest suggest-weights` command (ADR-0009) proposes adjustments,
   but activation requires the operator to:
   (a) run `--apply` to write the override file, and
   (b) set `SCORING_WEIGHTS_OVERRIDE` in `.env`.
   Neither step alone activates the change — a two-gate process that prevents
   automatic weight drift.

4. **Measurable accuracy**: The backtest engine (ADR-0008) pairs every sold
   outcome with the scoring snapshot available at decision time. This
   produces honest MAE, bias, and calibration metrics that the operator uses
   to decide whether to adjust weights. At 5+ sold outcomes the weight
   suggester becomes active; at fewer it returns "hold" for all signals.

5. **No ML requirement**: The heuristic engine works with zero training data.
   All four signals have sensible defaults that produce reasonable scores for
   any domain. The commercial and market signals degrade gracefully when
   keyword/comps data is absent (returning zero-volume / no-comparables).

## Consequences

### Positive
- The engine is deterministic: two runs with the same inputs produce identical
  scores. This is essential for the backtest engine's point-in-time correctness
  (ADR-0008).
- Confidence scoring is conservative by design: a domain with keyword volume
  but no comparable sales gets `confidence = 0.5` (one signal beyond
  intrinsic), not a higher value.
- The `suggested_buy_max` cap (default 500 EUR) acts as a circuit breaker:
  even if comparable sales suggest a domain is worth 10,000 EUR, the engine
  will not recommend a purchase beyond the operator's stated budget.
- The backtest engine provides an objective feedback loop. A weight adjustment
  that degrades MAE is immediately visible in the report.
- Over 300 tests cover the scoring engine, individual signals, weight loader,
  backtest engine, and weight suggester.

### Negative
- Manual weight tuning is subjective for the first 5-10 sale outcomes. The
  operator may over- or under-correct based on a small sample.
- The four-signal decomposition is a deliberate simplification. Interactions
  like "`.ai` TLD with trailing-edge keyword" are not captured; each signal
  is computed independently.
- The `BUY_MAX_ABSOLUTE_CAP` is a blunt instrument. A domain with strong
  signals (high keyword volume, strong comps) may be capped at 500 EUR even
  when buying at 500 EUR is a good deal. The operator can raise the cap, but
  this weakens the conservatism guarantee.

### Compliance and Security Implications
- The scoring engine does not make network calls (keyword/comps data is loaded
  at startup from local files). No data exfiltration risk.
- Weight override files are validated: an invalid JSON or non-1.0 weight sum
  causes the engine to log a warning and fall back to defaults. The engine
  never crashes on a malformed override.
- The engine never auto-activates weight changes. The two-gate process
  requires explicit operator action.

### Migration and Monitoring Plan
- **Migration**: None. This ADR documents the existing design.
- **Monitoring**: The `dominus backtest run` command produces a report on
  every call. The operator should inspect the report before and after any
  weight adjustment.
- **Rollback**: Revert `data/weights-override.json` or unset
  `SCORING_WEIGHTS_OVERRIDE` in `.env`. The engine falls back to
  `DEFAULT_WEIGHTS`.

### Validation
- All 9 scoring-engine tests and 22 signal tests pass (intrinsic: 10,
  commercial: 4, market: 7, expiry: 8).
- Backtest engine tests (15 tests) validate point-in-time correctness,
  idempotency, and calibration bucketing.
- Weight suggester tests (8 tests) validate the sample-size gate, delta
  capping, and renormalisation.
- Production validation: run `dominus backtest run` against recorded outcomes.
  The MAE and bias metrics should be inspectable and trend toward zero as
  weights are tuned and outcomes accumulate.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision previously documented in
`dominus-product-vision.md` (v0.2), now superseded by this ADR series.
Template: `docs/adr/template.md`.*
