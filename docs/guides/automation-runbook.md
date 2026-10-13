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
| `dns`        | DNS delegation to the parking provider                              | Planned (M3)           |
| `parking`    | Ads monetization                                                    | Planned (M3)           |
| `listing`    | Marketplace listing (delegates to `dominus listing`)                | **Implemented**        |

Steps without a registered executor are reported `skipped` with the reason
`no executor registered` — the pipeline is honest about what it can do
(ADR-0082). Until M2/M3 land, only `listing` executes.

## Enabling

```bash
# .env
AUTOMATION_ENABLED=true   # kill switch off
AUTOMATION_DRY_RUN=false  # execute for real (only after a dry-run pass)

# Optional, for the indexing step (M2):
INDEXNOW_KEY=              # openssl rand -hex 32 — enables /<key>.txt + IndexNow
AUTOMATION_CONTACT_EMAIL=  # published on for-sale pages; unset = no mailto
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

## Day-to-day commands

```bash
# Kill switch / dry-run state
dominus automate settings

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
| GET    | `/settings`      | Kill switch and dry-run flag                     |
| GET    | `/steps`         | Step journal (`domain`, `status`, `limit` query) |
| GET    | `/audit`         | Audit trail (`limit` query)                      |
| POST   | `/run`           | Run or resume the pipeline for a domain          |
| POST   | `/reset`         | Reset a step, or the whole pipeline (`step` optional) |

A `POST /run` while the kill switch is off returns `409` with code
`AUTOMATION_DISABLED`.

## Operating rules

1. **Dry-run first.** Enable `AUTOMATION_ENABLED=true` with
   `AUTOMATION_DRY_RUN=true`, run `dominus automate run <domain>` for a few
   domains, and read the journal. Only then set `AUTOMATION_DRY_RUN=false`.
2. **The kill switch is the brake.** Any mistake → set `AUTOMATION_ENABLED=false`.
   In-flight jobs finish their current step; new runs are refused and audited.
3. **Money steps keep their human gate.** Purchase auto-approval
   (`PURCHASE_AUTO_APPROVAL`) and offer acceptance are separate controls and are
   not enabled by this pipeline.
4. **Audit is the source of truth.** `dominus automate audit` records run start,
   every step transition and every kill-switch refusal with the trigger source.
5. **Failures are resumable.** A failed step can be retried after the external
   cause is fixed with `dominus automate run <domain>` (the journal skips the
   steps already done).
