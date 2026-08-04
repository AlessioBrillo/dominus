# ADR-0037: Pipeline Run Integrity at Scale

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-04 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0003, ADR-0011, ADR-0023, ADR-0035 |
| **Project** | DOMINUS |

## Context

Pipeline runs are executed asynchronously by the `JobWorker` (ADR-0023) and
large runs (hundreds to thousands of candidates) regularly exceed the fixed
per-stage timeout. The failure mode is silent and dangerous: when a stage's
`Promise.race` timeout fires with no results, the whole run completed with an
*empty* `passed` list and no marker — so a user could believe there were no
eligible domains, when in fact the run simply did not finish.

Three compounding defects made this worse:

1. **Fixed, candidate-independent timeout**: a single `stageTimeoutMs`
   (default 5 min per stage) did not scale with input size. A slow-but-finite
   stage on a large batch was indistinguishable from a hung stage.
2. **No partial-result harvesting**: on timeout the stage result was
   discarded wholesale. Candidates already processed were lost even though
   their per-candidate results were valid.
3. **No degradation signal**: nothing on the `PipelineRunResult`, the job
   queue, the API, the CLI, or the dashboard indicated that output was
   incomplete. Callers silently consumed truncated recommendations.

Separately, the RDAP confirmation stage cross-validated availability against
WHOIS port-43. A slow WHOIS server (or a block-prone ccTLD registry) could
hang the cross-validation for every candidate — one slow external dependency
capped the throughput and reliability of the whole stage, even after ADR-0035
made RDAP authoritative.

## Decision

Fully time-box every pipeline stage; harvest partial results on expiry; and
surface degraded output end-to-end so it is never mistaken for a clean "no
recommendations" run.

### Stage budget (orchestrator)

Replace the fixed `stageTimeoutMs` with a candidate-scaled budget
(`src/pipeline/orchestrator.ts`):

- `budgetMs = min(baseMs + perCandidateMs × inputCount, capMs)`.
  Defaults: base 30 s, 200 ms per candidate, cap 1 h, all configurable
  (`STAGE_TIMEOUT_BASE_MS`, `STAGE_TIMEOUT_PER_CANDIDATE_MS`,
  `STAGE_TIMEOUT_CAP_MS`, `STAGE_TIMEOUT_GRACE_MS`).
- When the budget expires, the stage's AbortController is aborted and a
  **grace window** (default 5 s) begins. If the stage resolves within grace
  (it propagates the abort signal to its providers), the *partial* result is
  harvested and the stage is marked `timedOut` for the purposes of
  accounting. If grace also elapses, the stage returns an empty result
  immediately.
- Every budget expiry (or stage error with no partial output) pushes a
  `StageDegradation` entry: `{ stageName, reason: 'timeout' | 'error',
  processedCount, expectedCount, message? }`.

### Degradation surfaced end-to-end

- `PipelineRunResult` gains `degraded: boolean` and `degradedReasons:
  StageDegradation[]`. `degraded = true` when any stage degraded *or* any
  stage returned an error (`stageErrors`), i.e. output may be incomplete.
- The job queue result (`PipelineRunResult`), the runs repository
  (`PipelineRunResults`), and `buildResultsSummary` in the run service carry
  `degraded` / `degradedReasons` through to persistence and the API
  (`POST /api/v1/runs` and run status responses).
- The CLI (`dominus run`) prints one warning per degradation with
  `processed X/Y candidates` and exits **non-zero** on a degraded run — in
  both synchronous mode and async polling — so scripts and automation cannot
  mistake the output for a clean verdict.
- The dashboard `Runs` page shows a banner for degraded runs listing each
  stage, reason, and processed/expected counts.

### WHOIS budget (RDAP confirmation)

`RdapConfirmationStage` gains a per-domain WHOIS budget
(`RDAP_WHOIS_BUDGET_MS`, default 1000 ms, min 50, max 5000;
`whoisBudgetMs` constructor parameter). The WHOIS cross-check races against
`AbortSignal.timeout(budget)` and is ignored when it loses: RDAP remains
authoritative (ADR-0035). A disagreement still blocks the candidate — but
only when WHOIS answers within budget, keeping the cross-validation
conservative without making run throughput hostage to slow WHOIS servers.

## Consequences

### Positive

- Large runs no longer complete silently empty: either the stage finishes
  (budget scales with candidate count) or the run completes marked
  `degraded` with an explicit reason and non-zero CLI exit.
- Partial results from budget-expired stages are preserved and counted
  (`processedCount`), so a timeout loses only the unprocessed tail, not the
  work already done.
- Degraded output is visible in the API response, persisted run record,
  CLI exit code, and dashboard banner — "no recommendations" is never
  conflated with "run timed out".
- The WHOIS cross-validation can no longer stall or cap the RDAP stage;
  throughput is bounded by the authoritative path.

### Negative

- Budget is a heuristic: a finite-but-brute-slow stage may still be aborted
  if it does not respect the abort signal and exceeds grace. Operators can
  raise `STAGE_TIMEOUT_*` or `RDAP_WHOIS_BUDGET_MS` for pathological inputs.
- Stage-level accounting (`processedCount`) is derived from returned
  `passed`/`filtered` counts; stages that discard results internally appear
  with a lower `processedCount` than actually processed.
- New config surface adds operational tuning surface (mitigated by sane
  defaults and documented in `.env.example`).

### Risks and mitigation

- **Abort coherence**: harvest relies on providers honouring the abort
  signal. `TrademarkGateStage` and the DNS/RDAP stages already propagate the
  signal; the grace window absorbs non-cooperative providers up to a bound.
- **False degradation on healthy runs**: a stage that emits a recoverable
  per-candidate error and no stage-level error is not degraded; only stage
  failures that truncate output mark the run. Errors already surfaced via
  `stageErrors` are now also reflected in `degraded`.
- **Exit-code breakage**: scripts that relied on `dominus run` returning 0
  for a timed-out run will now see 1. This is the intended loud-failure
  behaviour; quiet success was the original bug.