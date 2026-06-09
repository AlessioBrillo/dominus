# ADR-0019: Closed-Loop Auto Weight Tuning

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-09 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | ADR-0009 (extends — two-gate retention relaxed for auto-tune) |
| **Relates to** | ADR-0002, ADR-0007, ADR-0008, ADR-0018 |
| **Project** | DOMINUS |

## Context

The scoring engine's four signals (intrinsic, commercial, market, expiry) are
weighted by a manually-tuned weight vector (ADR-0002). The backtest engine
(ADR-0008) and weight suggester (ADR-0009) already provide:

1. A `backtest_signals` table joining scoring predictions to realised sale
   outcomes (point-in-time correct).
2. A `WeightSuggester` that compares per-signal scores against realised sale
   prices to propose weight adjustments.
3. A manual two-gate policy (ADR-0009): the CLI writes a JSON file; the
   operator must set `SCORING_WEIGHTS_OVERRIDE` to activate it.

In practice, the two-gate policy means weights are tuned reactively — only
when the operator remembers to run `suggest-weights`, review the output, and
manually apply. Real-world sold-outcome data accumulates continuously as the
portfolio generates outcomes, but the feedback loop remains open.

With the project moving toward production readiness (ADR-0018) and the
operator stating a preference for "completely automatic" weight tuning with
"completely customizable" guardrails, we need a closed-loop system that
automates the cycle while preserving safety boundaries.

## Decision Drivers

1. **Automatic operation** — the weight tuning loop must run unattended on a
   schedule, without requiring operator intervention for routine adjustments.
2. **Safety guardrails** — automatic changes must be bounded by configurable
   limits to prevent runaway drift, over-fitting, or operator-unapproved
   weight configurations.
3. **Audit trail** — every weight change must be recorded durably with
   metadata: source, sample size, timestamp, and rationale.
4. **Customisability** — each DOMINUS fork/installation must be able to set
   its own thresholds, schedules, and activation policies (per ADR-0018).
5. **Backward compatibility** — existing manual override path
   (`SCORING_WEIGHTS_OVERRIDE`) must continue to work and take precedence
   over auto-tuned weights.

## Considered Options

### Option A: Fully Automated Closed Loop (chosen)

Add an `AutoWeightTuner` service that orchestrates a complete cycle:
1. Snapshot the backtest signals table.
2. Run the weight suggester.
3. Validate against safety guardrails (min sample size, max per-signal delta,
   max total drift from defaults).
4. If safe: write the weights override file and record in a new
   `weight_snapshots` table.
5. If unsafe: skip application, log warnings, record the failure in the
   audit trail.

The cycle runs on a configurable cron schedule via the scheduler service,
and can be triggered manually via CLI (`dominus backtest auto-tune`) or API
(`POST /backtest/auto-tune`). Auto-tuned weights are loaded automatically
when `AUTO_TUNE_ENABLED=true` and no `SCORING_WEIGHTS_OVERRIDE` is set, but
manual override always takes precedence.

**Advantages:**
- Fully unattended operation after initial configuration.
- Six independent safety guardrails, all env-configurable.
- Every weight change recorded in the `weight_snapshots` table with full
  provenance (source, sample size, backtest timestamp).
- Dry-run mode for preview without side effects (default on).
- Backward compatible — manual override path unchanged.
- No new dependencies or paid services.

**Disadvantages:**
- Operational complexity: six new env vars to configure.
- Risk of silent weight drift if defaults are too permissive (mitigated by
  conservative defaults: dry-run on, min sample 20, max delta 5%).

**Cost Implications:** Zero — all new code in the existing stack
(Node.js + SQLite). No paid APIs or infrastructure.

**Risk Assessment:** Low. Safety guardrails, dry-run mode, and conservative
defaults prevent harmful weight configurations from reaching production.
The manual override path remains as a circuit breaker.

---

### Option B: Semi-Automated with Human Approval

Same as Option A, but the auto-tuner never writes the override file directly.
Instead, it sends a notification (via the existing notifier system) with the
suggested weights, and waits for the operator to run `--apply` to activate.

**Advantages:**
- Human-in-the-loop prevents any automated mistake.
- Familiar workflow for operators used to ADR-0009 two-gate policy.

**Disadvantages:**
- Still requires operator attention — contradicts the "completely automatic"
  requirement.
- Notification fatigue if the tuner runs frequently.
- Backtest-to-apply latency means the engine continues using stale weights.

**Cost Implications:** Same as Option A.

**Risk Assessment:** Low, but does not meet the primary driver of full
automation.

---

### Option C: Extend ADR-0009 with Better CLI UX Only

Keep the existing manual two-gate system but improve the CLI experience:
better formatting, diff view, and a `--preview` flag for the weight-override
file before it's activated.

**Advantages:**
- Minimal code change.
- Zero risk of automated mistakes.
- No new env vars or configuration surface.

**Disadvantages:**
- Does not close the feedback loop — operator still must remember and act.
- No audit trail for weight changes.
- Does not meet the "completely automatic" requirement.

**Cost Implications:** Very low — CLI formatting improvements only.

**Risk Assessment:** Lowest, but least valuable.

---

## Decision

**Chosen option: Option A — Fully Automated Closed Loop**

The decision is driven by two primary factors:

1. **Operator preference for full automation.** The stated requirement is
   "completely automatic" weight tuning. Option B (semi-automated) and
   Option C (manual only) do not satisfy this.

2. **Safety through configuration, not process.** Rather than requiring a
   human gate, we enforce six configurable safety guardrails:
   - `AUTO_TUNE_ENABLED` (master switch, default off)
   - `AUTO_TUNE_MIN_SAMPLE` (minimum sold outcomes, default 20)
   - `AUTO_TUNE_MAX_DELTA` (max per-signal change per pass, default 5%)
   - `AUTO_TUNE_MAX_DRIFT` (max total drift from defaults, default 20%)
   - `AUTO_TUNE_DRY_RUN` (preview mode, default on)
   - `SCORING_WEIGHTS_OVERRIDE` (manual override always wins)

   These guardrails provide more granular protection than a binary
   human-approval gate. The conservative defaults (dry-run on, min 20
   samples) mean no weight changes happen until the operator explicitly
   enables live tuning and accumulates sufficient outcome data.

3. **Audit trail completeness.** The `weight_snapshots` table records every
   weight change — whether from auto-tune, CLI override, or initial setup —
   giving the operator full visibility into the weight history. This exceeds
   the audit capability of Options B or C.

4. **Backward compatibility.** The existing `SCORING_WEIGHTS_OVERRIDE` path
   is preserved and takes priority over auto-tuned weights. Operators who
   prefer manual control can ignore `AUTO_TUNE_ENABLED` entirely.

## Consequences

### Positive
- The scoring engine continuously improves its weight configuration as new
  sold-outcome data accumulates.
- Operators can tune conservativeness per installation via env vars,
  supporting the forkability goal (ADR-0018).
- Every weight change is auditable via the `weight_snapshots` table.
- The system works unattended after initial configuration.
- Dry-run mode lets operators preview changes before enabling live tuning.

### Negative
- Safety guardrails can block legitimate adjustments if set too
  restrictively (operator education required).
- Weight drift is possible if defaults are too permissive (mitigated by
  conservative defaults and the manual override circuit breaker).
- Six new env vars increase the initial configuration surface.

### Compliance and Security Implications
- No compliance or regulatory impact — all tuning is based on the operator's
  own portfolio outcomes.
- The `weight_snapshots` table provides a tamper-evident audit log of all
  weight changes.

### Migration and Monitoring Plan
1. **Phase 1 (this ADR):** Implementation of `AutoWeightTuner`,
   `weight_snapshots` table, API/CLI/scheduler integration.
2. **Phase 2 (post-deployment):** Enable `AUTO_TUNE_ENABLED=true` with
   `AUTO_TUNE_DRY_RUN=true` for one full cycle to preview suggested weights.
3. **Phase 3 (live tuning):** Set `AUTO_TUNE_DRY_RUN=false` after reviewing
   the dry-run output and verifying safety guardrails are appropriate.
4. **Monitoring:** The scheduler logs each auto-tune outcome.
   Operators can query `weight_snapshots` to track weight history.

### Validation
- **Success criteria:** The weight suggester produces meaningful suggestions
  (not all holds) after sufficient outcomes are recorded. The auto-tuner
  applies them without human intervention.
- **Post-validation:** Compare backtest MAE and hit rate before and after
  auto-tuning to verify improvement.
- **Rollback:** Set `AUTO_TUNE_ENABLED=false` and/or set
  `SCORING_WEIGHTS_OVERRIDE` to a known-good weights file.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at
`docs/adr/0001-project-architecture.md`.*
