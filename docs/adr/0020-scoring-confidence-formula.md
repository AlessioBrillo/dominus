# ADR-0020: Scoring Confidence Formula and Intrinsic Quality Coupling

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0008 |
| **Project** | DOMINUS |

## Context

The scoring engine produces a `confidence` value (0.0–0.8 by default) alongside
`expectedValue` and `weightedScore`. Confidence answers the question: *how much
of the available signal weight was covered by actual data?* A domain with
keyword volume, comparable sales, and expiry history gets high confidence; a
domain with only an intrinsic evaluation gets low confidence.

The original formula (v0.1) used a simple per-signal additive model:
`confidenceBase + sum(confidencePerSignal × hasData)` with a hard cap at
`confidenceCap`. This was replaced in v0.2.1 with a
weight-covered-proportion formula that accounts for each signal's configured
weight.

However, the v0.2.1 formula introduced an undocumented coupling: 12% of the
confidence range is reserved for the intrinsic quality score, reducing the
signal-coverage contribution proportionally. This creates a scenario where a
domain with excellent commercial/market/expiry data but poor intrinsic quality
(hyphens, numbers, long string) has its confidence capped below the theoretical
maximum — even though all non-intrinsic signals have full data coverage.

This ADR documents the formula, the rationale for the coupling, and the
decision to expose the coupling factor as a configurable parameter.

## Decision Drivers

1. **Signal-coverage accuracy** — Confidence should primarily reflect how many
   signals have real data, not the quality of that data.
2. **Intrinsic quality floor** — A name that is objectively bad (long,
   hyphen-heavy, numeric-only) should have a realistically damped confidence
   even if keyword volume and sales data are excellent.
3. **Configurable conservatism** — The coupling strength should be tunable
   without code changes, respecting Principle 5 (scoring conservatism).
4. **Backward compatibility** — Existing scoring runs must retain their
   relative ordering after configuration changes.

## Considered Options

### Option A: Promote `intrinsicQualityInfluence` to a config constant (chosen)

Move the hardcoded `0.12` into `ScoringConstants.intrinsicQualityInfluence`
with a default of `0.12`, exposed as `SCORING_INTRINSIC_QUALITY_INFLUENCE`
in the environment configuration.

**Advantages:**
- Zero behavioural change for existing installations (default matches current)
- Operator can tune the coupling without code changes
- Documented in the Zod schema with full JSDoc rationale
- Follows the existing pattern of all scoring calibration constants
- The `confidencePerSignal` deprecated field can finally be removed from the
  Zod schema (made optional) since the weight-covered formula supersedes it

**Disadvantages:**
- Adds one more env var to the ~125 existing ones
- Requires a new ADR to document the formula retroactively

**Risk Assessment:** Minimal. The default is identical to the current value.
Changing it only affects relative confidence values, not buy/sell decisions
(the `recommended` threshold is independent).

---

### Option B: Remove intrinsic coupling entirely

Set `intrinsicQualityInfluence = 0` and derive confidence purely from the
proportion of signal weight covered by data.

**Advantages:**
- Mathematically pure: confidence reflects data coverage, not quality
- Simpler to explain and document

**Disadvantages:**
- A domain like `xkcd-7832-xyzzy.net` with keyword volume 100k + $20 CPC
  would receive the same confidence as `example.com` with the same data,
  despite the hyphen/number penalties making it a clearly worse investment
- Violates Principle 5 (conservatism): confidence should be conservative,
  and penalising bad names is conservative
- Existing tuning data based on the coupling would shift

**Cost Implications:** No implementation cost, but requires re-tuning all
existing weight configurations.

**Risk Assessment:** Medium. Changes the relative ordering of all candidates
and invalidates existing backtest-to-tuning feedback loops.

---

### Option C: Dynamic coupling based on signal variance

Compute `intrinsicQualityInfluence` dynamically from the variance of intrinsic
scores across the candidate pool — names with unusually high/low intrinsic
quality get more/less influence.

**Advantages:**
- Adapts to the candidate set automatically
- No manual tuning needed

**Disadvantages:**
- Non-deterministic across different candidate lists
- Impossible to backtest: the same domain would get different confidence
  depending on which other domains were in the same pipeline run
- Complexity: adds runtime state to a pure function

**Risk Assessment:** High. Non-determinism violates the principle of
deterministic scoring required for backtest correctness (ADR-0008).

## Decision

**Chosen option: Option A** — Expose `intrinsicQualityInfluence` as a
configurable constant in `ScoringConstants`, defaulting to `0.12`.

The choice preserves full backward compatibility while making the coupling
visible, documented, and tunable. The value `0.12` was empirically chosen
during v0.2.1 development: it provides enough damping to penalise clearly
bad names (long, hyphen-heavy) without overwhelming the signal-coverage
contribution when three of four signals have real data.

The confidence formula is:

```
coveredWeight = intrinsic.weight
              + (hasCommercialData ? commercial.weight : 0)
              + (hasMarketData ? market.weight : 0)
              + (expiryHasData ? expiry.weight : 0)

extraCovered = max(0, coveredWeight - intrinsic.weight)
variableRange = 1 - intrinsic.weight

signalConfidence = (extraCovered / variableRange)
                 × (confidenceCap - confidenceBase)
                 × (1 - intrinsicQualityInfluence)

qualityBoost = intrinsic.score
             × intrinsicQualityInfluence
             × (confidenceCap - confidenceBase)

confidence = min(confidenceCap,
                 confidenceBase
                 + signalConfidence
                 + qualityBoost)
```

The `intrinsicQualityInfluence` factor splits the confidence range into two
portions: `(1 - influence)` goes to signal coverage, `influence` goes to
intrinsic quality. At the default `0.12`, 88% of the range above the base is
driven by data coverage and 12% by intrinsic quality. This means:
- A perfect name (all data present, high intrinsic) reaches `confidenceCap` (0.8)
- A terrible name (all data present, intrinsic=0) reaches `0.8 - 0.12 × 0.6 = 0.728`
- A name with no data but high intrinsic reaches `0.2 + 0.12 × 1.0 × 0.6 = 0.272`

## Consequences

### Positive
- The coupling is now documented, versioned, and tunable via environment config
- Default zero-change for existing installations
- The `SCORING_CONFIDENCE_PER_SIGNAL` env var can be deprecated properly
  (made optional) since the weight-covered formula supersedes it
- Follows the established pattern for all scoring calibration constants
  (`SCORING_BUY_MAX_RATIO`, `SCORING_CONFIDENCE_CAP`, etc.)

### Negative
- Adds one configuration parameter to the ~125 existing env vars
- Requires updating the composition root to pass the new parameter

### Compliance and Security Implications
None. This is a pure computation parameter with no security or compliance
surface.

### Migration and Monitoring Plan
- The change is deployed as part of a hardening sprint — no separate rollout
- Existing pipeline runs retain their original confidence values in `scoring_runs`
  (the formula is applied at scoring time, not retroactively)
- New runs use the configurable value; default `0.12` matches the old hardcoded value

### Validation
- All existing scoring tests continue to pass with the default value
- The backtest engine's calibration reports show the same confidence-bucket
  distribution before and after the change (default-to-default comparison)
- Operators can validate by setting `SCORING_INTRINSIC_QUALITY_INFLUENCE=0`
  and observing that confidence now depends solely on data coverage

---

*This ADR was created following the MADR 4.0.0 standard. See
[ADR-0002](0002-scoring-engine-design.md) for the conservatism principle and
[ADR-0008](0008-backtest-engine.md) for backtest correctness requirements.*
