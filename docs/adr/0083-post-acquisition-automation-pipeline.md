# ADR-0083: Post-Acquisition Automation Pipeline

## Metadata

| Field          | Value                                                    |
| -------------- | -------------------------------------------------------- |
| **Status**     | Accepted                                                 |
| **Date**       | 2026-10-12                                               |
| **Authors**    | Alessio Brillo                                           |
| **Deciders**   | Alessio Brillo                                           |
| **Supersedes** | —                                                        |
| **Relates to** | ADR-0002, ADR-0004, ADR-0023, ADR-0038, ADR-0082          |
| **Project**    | DOMINUS                                                  |

## Context

Until now the DOMINUS workflow ended at the decision. The five-stage pipeline
and the acquisition funnel produce a buy/pass verdict with a purchase ceiling;
`PurchaseService` can execute a purchase at an active registrar; a won auction
is recorded through `AcquisitionService`. Everything **after** the domain is
acquired was manual:

- `AutoListingService` lists a bought domain on a marketplace, but it was invoked
  fire-and-forget from two call sites with no journal, no retry state and no
  visibility. (It was also never registered as a job handler, so enqueued
  `AUTO_LIST` jobs dead-lettered with "No handler registered" — a latent bug.)
- Landing pages, SEO indexing, DNS delegation to a parking provider, ads
  monetization, cross-marketplace listing and offer handling did not exist.

The product goal is a complete, clean, automated lifecycle: buy decision →
registrar → automatic indexing of the purchased domain → automatic ads
monetization → automatic marketplace listing with offers, so an operator does
nothing and the domain becomes self-sustaining. That automation spends real
money and mutates DNS, so it needs the same conservatism the scoring engine
already has (ADR-0002), the same provider abstraction as every other external
dependency (ADR-0004), and the same async-by-default execution model as the
pipeline itself (ADR-0023).

## Decision Drivers

1. One place where "what happens after the purchase" is defined — not two
   fire-and-forget call sites.
2. Idempotent and resumable: a crashed or retried job must not duplicate
   listings, DNS changes or purchases.
3. Money- and DNS-mutating steps must be impossible to enable accidentally:
   kill switch plus dry-run by default, audit trail of every autonomous action.
4. Steps that need an external account (parking, marketplace APIs) must be
   addable behind their interface without touching the orchestrator — and must
   not be declared before they work (ADR-0082).

## Considered Options

### Option A: Keep the two fire-and-forget hooks, add steps inline

**Advantages:** no new subsystem.

**Disadvantages:** no journal, no idempotency, no kill switch, no audit; every
new step deepens two unrelated call sites. Rejected.

### Option B: Journaled post-acquisition pipeline with a step registry (chosen)

A `PostAcquisitionService` orchestrator runs an ordered list of steps
(`portfolio → site → indexing → dns → parking → listing`), each implemented as
a `PostAcquisitionStepExecutor` behind an interface. Every step transition is
journaled in `post_acquisition_steps` (one row per domain+step+tenant) and
audited in `automation_audit`. The whole pipeline is gated by `AUTOMATION_ENABLED`
(kill switch, default off) and `AUTOMATION_DRY_RUN` (default on): steps that
spend money or mutate DNS must check the flag and skip.

**Advantages:** idempotent/resumable, auditable, kill-switch safe, extensible;
fixes the unregistered `AUTO_LIST` handler as a side effect.

**Disadvantages:** new tables and wiring; a failed step halts the chain (chosen
deliberately — downstream steps depend on earlier ones).

### Option C: Wrapper script around external tools (no in-app pipeline)

**Advantages:** zero code in the core.

**Disadvantages:** no scoring/portfolio integration, no audit, no decision-first
UX (Principle 2). Rejected.

## Decision

1. **Post-acquisition pipeline** (`src/services/post-acquisition-service.ts`):
   ordered steps from `POST_ACQUISITION_STEPS`, one `PostAcquisitionStepExecutor`
   per step. A completed step is never re-run until reset; a failed step halts the
   chain; a skipped step does not.
2. **Journal + audit**: `post_acquisition_steps` (unique domain+step+tenant,
   `attempts`, `status`, `detail_json`, `last_error`) and `automation_audit`
   (action, domain, actor, detail). Tenant isolation is repository-enforced via
   `resolveTenantId()` like the other post-1.0 tables.
3. **Safety gates**: `AUTOMATION_ENABLED` (default `false`) refuses every run and
   audits `automation_disabled`; `AUTOMATION_DRY_RUN` (default `true`) is
   forwarded to every executor, which must skip money/DNS actions.
4. **Execution**: `POST_ACQUISITION` job on the existing queue (ADR-0023) when
   the worker is enabled, inline otherwise; the purchase and won-auction paths
   call a `PostAcquisitionTrigger` instead of the old fire-and-forget auto-list.
5. **Step executors land with their milestone**: `listing` now (delegating to
   `AutoListingService`), `site`/`indexing`/`dns`/`parking` when their providers
   exist — never declared before they work (ADR-0082). Until then the
   orchestrator reports them `skipped` with `no executor registered`.
6. **AutoListHandler registration fix**: `AUTO_LIST` and `POST_ACQUISITION`
   handlers are registered by `buildWorkerIfEnabled`, closing the dead-letter
   gap for jobs enqueued after a purchase.

## Consequences

**Positive:** the purchase path becomes one auditable pipeline; operators can
dry-run the whole lifecycle before enabling it; new steps (parking, SEO, DNS)
are one adapter plus one executor, not a change to purchase code.

**Negative:** two new tables and migrations (additive, backward compatible);
the operator must understand the kill switch before enabling automation.

**Risk Assessment:** low-medium. The dangerous steps (money, DNS) are exactly
the ones gated by dry-run + kill switch; the default configuration performs no
external mutation.

## Post-implementation review findings (fixed)

A critical review of the first implementation found and fixed:

1. **Handler registration was untestable and had already failed once.**
   `AutoListHandler` was never registered, so every `AUTO_LIST` job
   dead-lettered. Handler construction is now extracted into
   `buildJobHandlers()` and a test asserts the registered set matches
   `REQUIRED_JOB_TYPES` (read from the `JobType` union source), with
   `WEIGHT_TUNE` marked conditional on `AUTO_TUNE_ENABLED`.
2. **Concurrent runs of the same domain could interleave.** Two triggers
   (purchase + manual run, or a retried job) both passed the "already done"
   check before either completed. Runs are now serialized per domain inside
   the process; the journal remains the source of truth.
3. **`domain_sites` upsert had no tenant guard.** Two tenants tracking the
   same domain could silently overwrite each other's published page. The
   conflict target is now `(domain, tenant_id)`; the public read picks the
   most recently updated page and the sitemap lists one entry per domain.
4. **`automation_audit` grew without bound** on long-running installs. The
   `data-prune` job now deletes rows older than
   `AUTOMATION_AUDIT_RETENTION_DAYS` (default 90), and reports the count in
   `PruneResult.deletedAutomationAudit`.
5. **Malformed stored snapshots could turn a public read into a 500.**
   `GET /public/for-sale/:domain` now parses the score snapshot defensively
   and caches the JSON response like the HTML one.
6. **CLI accepted any `--source` string**, which would be persisted into the
   journal. The command now validates against the trigger-source enum.

## Compliance Check

- [x] ADR-0002 conservatism: default configuration performs no money/DNS action.
- [x] ADR-0004 provider abstraction: every step executor depends on interfaces.
- [x] ADR-0023 async execution: job queue with priority, attempts, dead letters.
- [x] ADR-0038 usage metering: post-purchase bookkeeping stays outside plan gates.
- [x] ADR-0082 honesty: no step is declared before its executor exists.
- [x] English identifiers and comments throughout.
