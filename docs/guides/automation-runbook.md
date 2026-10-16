# Automation Runbook

The post-acquisition automation pipeline (ADR-0083) is the automated tail of the
buy decision: once a domain is acquired — registrar purchase, won auction, or a
manually recorded purchase — DOMINUS can run the follow-up steps without manual
work.

**The pipeline is shipped dark.** `AUTOMATION_ENABLED` defaults to `false` and
`AUTOMATION_DRY_RUN` defaults to `true`: out of the box every run is refused,
and once enabled, every run journals its steps but performs no action that
spends money or mutates DNS.

## Pipeline steps

Steps run in this order; a completed step is never re-run until reset, and a
failed step halts the chain (later steps depend on earlier ones):

| Step         | What it does                                                        | Status in this release |
| ------------ | ------------------------------------------------------------------- | --------------------- |
| `portfolio`  | Portfolio bookkeeping (renewal clock, acquisition cost)             | Done by the caller before the pipeline runs |
| `site`       | For-sale page generated from scoring data, published at `/public/for-sale/<domain>` | **Implemented** |
| `indexing`   | IndexNow submission of the for-sale page (+ sitemap inclusion)       | **Implemented** |
| `dns`        | DNS delegation to the parking provider                              | **Implemented** (M3, fail-closed write gate) |
| `parking`    | Ads monetization                                                    | **Implemented** (M3, revenue ingestion as a read) |
| `listing`    | Marketplace listing (delegates to `dominus listing`)                | **Implemented**        |

Steps without a registered executor are reported `skipped` with the reason
`no executor registered` — the pipeline is honest about what it can do
(ADR-0082).

## Two switches: the operator brake and the tenant opt-in

Automation has **two** gates, and both must allow a run:

1. **Operator brake (env)** — `AUTOMATION_ENABLED` (default `false`) refuses
   every run on the deployment; `AUTOMATION_DRY_RUN` (default `true`) forces
   simulation. The operator brake can only ever tighten a tenant's wish, never
   loosen it.
2. **Tenant opt-in (database)** — `tenant_automation_settings`, one row per
   tenant, managed from the dashboard or the CLI. Defaults to opted out with
   dry-run on, so a tenant that never touched the settings never runs anything.

The effective gate is the conservative combination:

```
effective.enabled = env.AUTOMATION_ENABLED AND  tenant.enabled
effective.dryRun  = env.AUTOMATION_DRY_RUN  OR   tenant.dryRun
```

A run refused by the operator brake audits `automation_disabled`; a run refused
by the tenant switch audits `tenant_automation_disabled`.

## Enabling

```bash
# .env — the operator brake (server-wide)
AUTOMATION_ENABLED=true   # kill switch off
AUTOMATION_DRY_RUN=true   # keep simulating even after the tenant opts in

# Optional, for the indexing step (M2):
INDEXNOW_KEY=              # openssl rand -hex 32 — enables /<key>.txt + IndexNow
AUTOMATION_CONTACT_EMAIL=  # published on for-sale pages; unset = no mailto

# Optional, for the dns step (M3):
DNS_WRITE_PROVIDER=cloudflare   # 'manual' (default) = no automation
DNS_WRITE_CLOUDFLARE_API_TOKEN= # falls back to REGISTRAR_CLOUDFLARE_API_TOKEN
AUTOMATION_DNS_RECORD_TYPE=A    # or CNAME
AUTOMATION_DNS_RECORD_VALUE=    # parking IP or hostname; unset = step skips
AUTOMATION_DNS_RECORD_NAME=@    # apex by default

# Optional, for the parking step (M3):
MONETIZATION_PROVIDER=csv       # 'manual' (default) = step skips honestly
MONETIZATION_REVENUE_PATH=      # CSV with columns domain,date,amount_eur
```

The tenant opt-in lives in the database and is flipped from the dashboard
(**Automation** page → *Automation* / *Dry-run* toggles) or the CLI:

```bash
dominus automate settings --enabled true    # opt this tenant in
dominus automate settings --dry-run false   # allow real execution (still requires AUTOMATION_DRY_RUN=false)
```

With the worker running (`WORKER_ENABLED=true`, the default), the purchase and
won-auction paths enqueue a `POST_ACQUISITION` job; the pipeline then runs
asynchronously. With the worker disabled, the same trigger runs the pipeline
inline.

## What the site and indexing steps do (M2)

- `site` generates the for-sale page from the scoring engine (asking price =
  suggested list price, appraisal summary, confidence) and publishes it at
  `/public/for-sale/<domain>`, with Schema.org `Offer` structured data. No
  private portfolio data (acquisition cost, renewal dates) is ever exposed.
- `indexing` submits that URL to IndexNow (Bing/Yandex/Seznam). It skips —
  honestly — in dry-run, without `INDEXNOW_KEY`, or without a public
  `PUBLIC_APP_URL` (self-hosted instances without a public origin cannot verify
  key ownership). The page is included in `/public/sitemap.xml` regardless.

## What the DNS step does (M3)

The `dns` step delegates the domain to the configured parking target
(`AUTOMATION_DNS_RECORD_TYPE` + `AUTOMATION_DNS_RECORD_VALUE`) through a
fail-closed write gate (ADR-0083 amendment, 2026-10-14). Before any write,
the gate reaches an independently corroborated conclusion about what the
current state *is*:

1. the write provider's own view of the zone (`DNS_WRITE_PROVIDER`,
   `cloudflare` or `manual`), and
2. a public-DNS read of the domain's NS delegation.

The write happens only when both legs agree and the domain is not already
resolving to the target; afterwards the result is confirmed publicly. The
outcomes are deliberately conservative:

| Outcome                                            | Journal state | Meaning |
| -------------------------------------------------- | ------------- | ------- |
| No write provider / no target / zone not managed    | `skipped`     | with the manual instructions recorded in `detail_json` |
| Public NS ≠ the provider's nameservers              | `skipped`     | the write would not take effect — fix the delegation first |
| Public DNS cannot answer the delegation             | `skipped`     | cannot corroborate, so no write (fail closed) |
| Already resolving to the target                     | `done`        | idempotent no-op |
| Applied and confirmed publicly                      | `done`        | records changed are recorded |
| Applied but not confirmed publicly                  | `failed`      | named `write_unconfirmed`, resumable with `dominus automate reset <domain> dns` |

## What the parking step does (M3)

The `parking` step records the ad revenue of the domain. **Revenue
ingestion is a read, not a write** (ADR-0083 amendment): the step only
records what a monetization source reports and never mutates external
state. Writes are idempotent at (domain, date, source) granularity, so a
re-run corrects figures instead of double-counting them, and negative
amounts are stored as reported (they are corrections).

The community edition ships a CSV reader — the operator exports the
revenue CSV from their parking/ads dashboard (`domain,date,amount_eur`)
and DOMINUS ingests it through the same interface a provider API adapter
will implement later. Provider API adapters land only with verified
vendor access (ADR-0082): until then the step skips honestly with
`monetization_provider_unavailable` rather than pretending.

| Outcome                                | Journal state |
| -------------------------------------- | ------------- |
| Dry-run                                | `skipped` `dry_run` |
| No monetization source configured       | `skipped` `monetization_provider_unavailable` |
| Provider unreachable                    | `failed` (retryable) |
| Revenue recorded                        | `done`, with the totals in `detail_json` |

## Sustainability: carry cost vs ad revenue (M5)

The `revenue-sync` scheduler job (default daily at 07:00,
`SCHEDULER_REVENUE_SYNC_CRON`) ingests revenue through the same
read-only path as the parking step — re-fetching the
`REVENUE_SYNC_LOOKBACK_DAYS` window so corrections are picked up, never
duplicated. With no monetization provider configured it records nothing
and reports so honestly.

The carry-cost verdict then answers the sustainability question for every
held domain: annualised ad revenue against the annual renewal cost.

- **sustainable** — the revenue covers the renewal
- **marginal** — it covers part of it
- **loss** — it does not: the domain is a reprice/drop candidate
- **insufficient_data** — less than 30 days of revenue: never judged
  (conservatism over speed)

A `loss` verdict **never drops a domain by itself**: it refines a `Keep`
verdict from the drop engine into `Reprice` (visible in the portfolio and
in `GET /api/v1/sustainability`), so the drop decision keeps its human
gate. The Portfolio page shows the same table as *Carry cost vs ad
revenue*.

## Marketplace automation (M4, partial)

The tenant listing policy controls the parts of marketplace automation
that work today without vendor API access:

- **Listing price policy** — `scoring` (default): new automatic listings
  use the conservative price the scoring engine computes. `fixed`: they
  use the tenant's own base price instead. Set from the Listings page →
  *Listing policy*, or `PUT /api/v1/listings/settings`.
- **Offer rules** — offers below `offerAutoDeclineBelowEur` are declined
  automatically and the listing returns to `listed`; offers below
  `offerCounterEur` are countered at that price. Both default to off:
  with no rule configured every offer stays pending for a human decision,
  exactly as before. The decline floor is always checked first, so it
  wins over the counter rule.

The Dan.com / Afternic / Sedo ListingProvider adapters and the remote
offer sync stay out until their APIs are verified (ADR-0082): an adapter
that was never exercised against the vendor is worse than an absent one.
Until then the `listing` step tracks listings locally through the manual
provider and `listing sync` degrades to the local mirror.

## Day-to-day commands

```bash
# Kill switch / dry-run state (global brake + this tenant's opt-in)
dominus automate settings
dominus automate settings --enabled true
dominus automate settings --dry-run false

# Step journal (all domains, or one domain), optionally filtered by status
dominus automate status
dominus automate status vintagecoffee.com --status failed

# Run or resume the pipeline for a domain (--reset clears the journal first)
dominus automate run vintagecoffee.com --source purchase
dominus automate run vintagecoffee.com --reset

# Reset one step so the next run executes it again
dominus automate reset vintagecoffee.com dns

# Audit trail of autonomous actions
dominus automate audit --limit 50
```

## API

All routes are under `/api/v1/automation` and require authentication:

| Method | Path             | Purpose                                          |
| ------ | ---------------- | ------------------------------------------------ |
| GET    | `/settings`      | Global brake, this tenant's switch and the effective gate |
| PUT    | `/settings`      | Enable/disable automation or dry-run for this tenant |
| GET    | `/steps`         | Step journal (`domain`, `status`, `limit` query) |
| GET    | `/audit`         | Audit trail (`limit` query)                      |
| POST   | `/run`           | Run or resume the pipeline for a domain          |
| POST   | `/reset`         | Reset a step, or the whole pipeline (`step` optional) |

A `POST /run` while a switch refuses the run returns `409` with code
`AUTOMATION_DISABLED` (operator brake) or `TENANT_AUTOMATION_DISABLED`
(tenant opt-out). `PUT /settings` on a deployment without a settings store
returns `501` with code `AUTOMATION_SETTINGS_UNAVAILABLE`.

## Operating rules

1. **Dry-run first.** Enable `AUTOMATION_ENABLED=true` with
   `AUTOMATION_DRY_RUN=true`, opt the tenant in
   (`dominus automate settings --enabled true`), run `dominus automate run
   <domain>` for a few domains, and read the journal. Only then set both
   dry-run switches off.
2. **The kill switch is the brake.** Any mistake → set `AUTOMATION_ENABLED=false`.
   In-flight jobs finish their current step; new runs are refused and audited.
   The same applies per tenant: `dominus automate settings --enabled false`
   opts this tenant out without touching the rest of the platform.
3. **Money steps keep their human gate.** Purchase auto-approval
   (`PURCHASE_AUTO_APPROVAL`) and offer acceptance are separate controls and are
   not enabled by this pipeline.
4. **Audit is the source of truth.** `dominus automate audit` records run start,
   every step transition and every switch refusal (operator or tenant) with the
   trigger source.
5. **Failures are resumable.** A failed step can be retried after the external
   cause is fixed with `dominus automate run <domain>` (the journal skips the
   steps already done).
6. **Concurrency.** Two triggers for the same domain (purchase plus a manual
   run, or a retried job) are serialized, so a step never executes twice in
   parallel; the journal is the source of truth for what already ran.
7. **Housekeeping.** The `data-prune` job deletes `automation_audit` rows older
   than `AUTOMATION_AUDIT_RETENTION_DAYS` (default 90). The step journal itself
   is bounded by the portfolio size and is never pruned.
