# Architecture Decision Records

This directory contains all Architecture Decision Records (ADRs) for DOMINUS.
ADRs document the _why_ behind non-obvious design choices so future
maintainers (including future-you) can re-derive the trade-offs without
re-running the original arguments.

| ADR                                                          | Title                                                                                                       | Date       | Status                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------- |
| [0001](0001-project-architecture.md)                         | Project architecture and technology decisions                                                               | 2026-06-08 | Superseded (see ADR-0026, ADR-0027) |
| [0002](0002-scoring-engine-design.md)                        | Scoring engine design and conservatism principle                                                            | 2026-06-08 | Accepted (retrospective)            |
| [0003](0003-pipeline-stage-separation.md)                    | Pipeline stage separation                                                                                   | 2026-06-08 | Accepted (retrospective)            |
| [0004](0004-provider-abstraction-pattern.md)                 | Provider abstraction pattern                                                                                | 2026-06-08 | Accepted (retrospective)            |
| [0005](0005-sqlite-schema-and-migrations.md)                 | SQLite schema and migration strategy                                                                        | 2026-06-08 | Accepted (retrospective)            |
| [0006](0006-trademark-gate-mandate.md)                       | Trademark gate mandate                                                                                      | 2026-06-08 | Accepted (retrospective)            |
| [0007](0007-backtest-signals-schema.md)                      | backtest_signals schema for prediction-vs-reality audit                                                     | 2026-06-06 | Accepted                            |
| [0008](0008-backtest-engine.md)                              | Backtest engine — joining predictions to outcomes with point-in-time correctness                            | 2026-06-06 | Accepted                            |
| [0009](0009-weight-recalibration-suggestion.md)              | Weight recalibration suggestion with manual approval                                                        | 2026-06-06 | Accepted                            |
| [0010](0010-rescore-bridge-decision.md)                      | Portfolio rescore bridge — why DNS/RDAP are bypassed on owned domains                                       | 2026-06-06 | Accepted (retrospective)            |
| [0011](0011-pipeline-runs-schema.md)                         | pipeline_runs schema — durable history of every pipeline execution                                          | 2026-06-07 | Accepted                            |
| [0012](0012-trademark-matching-policy.md)                    | Trademark matching policy and `.com` USPTO fallback                                                         | 2026-06-07 | Accepted                            |
| [0013](0013-domain-parsing-consolidation.md)                 | Domain parsing consolidation — canonical SLD/TLD across scoring and trademark gate                          | 2026-06-07 | Accepted                            |
| [0014](0014-euipo-api-migration.md)                          | EUIPO provider migration to Trademark Search 1.1.0 (RSQL + X-IBM-Client-Id)                                 | 2026-06-07 | Accepted                            |
| [0015](0015-psl-parser-adoption.md)                          | Adopt full Public Suffix List via `psl` npm Package                                                         | 2026-06-07 | Accepted                            |
| [0016](0016-registrar-abstraction.md)                        | Registrar provider abstraction                                                                              | 2026-06-08 | Accepted                            |
| [0017](0017-api-authentication.md)                           | API authentication                                                                                          | 2026-06-08 | Accepted                            |
| [0018](0018-open-source-architecture.md)                     | Open-source architecture and forkability                                                                    | 2026-06-09 | Superseded (see ADR-0025, ADR-0026) |
| [0019](0019-auto-weight-tuning-loop.md)                      | Closed-loop auto weight tuning                                                                              | 2026-06-09 | Accepted                            |
| [0020](0020-scoring-confidence-formula.md)                   | Scoring confidence formula and intrinsic quality coupling                                                   | 2026-06-11 | Accepted                            |
| [0021](0021-provider-resilience-and-observability.md)        | Provider resilience and observability layer                                                                 | 2026-06-12 | Accepted                            |
| [0022](0022-backup-and-operations.md)                        | Backup and operations                                                                                       | 2026-06-13 | Accepted                            |
| [0023](0023-job-queue-worker-pool-architecture.md)           | Job queue and worker pool architecture                                                                      | 2026-06-16 | Accepted                            |
| [0024](0024-portfolio-pnl-analytics.md)                      | Portfolio P&L tracking and analytics frontend                                                               | 2026-06-18 | Accepted                            |
| [0025](0025-license-change-agpl-commercial.md)               | License change — MIT to AGPL v3 + Commercial                                                                | 2026-06-18 | Proposed                            |
| [0026](0026-monetization-and-saas-model.md)                  | Monetization and SaaS model                                                                                 | 2026-06-18 | Proposed                            |
| [0027](0027-saas-architecture-multi-tenant.md)               | SaaS architecture — multi-tenancy, database, and authentication                                             | 2026-06-18 | Proposed                            |
| [0028](0028-frontend-architecture-professional-dashboard.md) | Frontend architecture — professional SaaS dashboard                                                         | 2026-06-18 | Proposed                            |
| [0029](0029-conversion-driven-features.md)                   | Conversion-driven features for DOMINUS Cloud                                                                | 2026-06-21 | Proposed                            |
| [0030](0030-public-namespace-architecture.md)                | Public namespace architecture                                                                               | 2026-06-21 | Proposed                            |
| [0031](0031-production-hardening.md)                         | Production hardening — CSP, auth DI, rate limiting, retry consolidation                                     | 2026-06-26 | Accepted                            |
| [0032](0032-cloud-authentication.md)                         | Cloud authentication — external identity provider (Auth0)                                                   | 2026-06-26 | Proposed                            |
| [0033](0033-cloud-redis-infrastructure.md)                   | Cloud Redis infrastructure — distributed rate limiting, job queue, cache                                    | 2026-06-26 | Proposed                            |
| [0034](0034-multi-tenant-data-model.md)                      | Multi-tenant data model — tenant ID column + PostgreSQL RLS                                                 | 2026-06-26 | Proposed                            |
| [0035](0035-rdap-authoritative-bootstrap.md)                 | RDAP authoritative bootstrap — IANA per-TLD resolution, strict 404 semantics                                | 2026-08-02 | Accepted                            |
| [0036](0036-license-and-ip-protection.md)                    | License and IP protection hardening — AGPL-3.0-only, CLA/CI gates                                           | 2026-08-01 | Accepted                            |
| [0037](0037-pipeline-run-integrity-at-scale.md)              | Pipeline run integrity at scale — candidate-scaled stage budgets, degraded output surfacing, WHOIS time-box | 2026-08-04 | Accepted                            |
| [0038](0038-usage-enforcement.md)                            | Usage enforcement — metered candidate scoring, API calls, and portfolio tracking with chokepoint metering   | 2026-08-07 | Accepted                            |
| [0039](0039-dns-consensus-degradation-policy.md)             | DNS consensus failure policy — fail-closed with degraded-run flagging and verdict metrics                     | 2026-08-07 | Accepted                            |
| [0040](0040-dns-consensus-fallback-parity.md)                | DNS consensus fallback parity — 2-of-3 gate on every resolution path                                          | 2026-08-07 | Accepted                            |
| [0041](0041-provider-fair-share.md)                          | Distributed per-tenant provider fair share — tenant windows on shared Redis budgets                           | 2026-08-07 | Accepted                            |
| [0042](0042-provider-dns-private-recursor.md)                | DNS consensus private recursor — Unbound override, consensus independent of public DoT egress                | 2026-08-07 | Accepted                            |
| [0043](0043-configurable-public-rate-limits.md)               | Configurable per-IP rate limits on the public namespace — PUBLIC/PER_DOMAIN/POST rate caps via env          | 2026-08-07 | Accepted                            |
| [0044](0044-dns-consensus-budget-and-doh-pool.md)             | DNS consensus budget and DoH keep-alive pooling — dedicated secondary budget, verification ceiling, shared Agent | 2026-08-07 | Accepted                            |
| [0045](0045-dns-consensus-tertiary-leg.md)                    | DNS consensus third leg — optional tertiary opinion rescuing Available verdicts the secondary cannot confirm  | 2026-08-08 | Accepted                            |
| [0046](0046-image-supply-chain-pinning.md)                    | Immutable image supply chain — digest pins, no floating tags, registry-verified overrides                       | 2026-08-08 | Accepted                            |
| [0047](0047-doh-json-legs-verified.md)                        | Live-verified DoH legs — provider endpoint fixes, RFC 8484 wire leg for Quad9                                  | 2026-08-08 | Accepted                            |
| [0048](0048-resolver-groups-wire-format.md)                    | Custom resolver groups accept the DoH wire format — ADR-0047 config gap, doc drift cleanup                    | 2026-08-08 | Accepted                            |
| [0049](0049-rdap-transport-parity.md)                          | RDAP transport parity — shared undici keep-alive pool and connection budget                                   | 2026-08-09 | Accepted                            |
| [0050](0050-rdap-consensus.md)                                 | RDAP consensus — opt-in 2-of-2 second opinion, dedicated budget, degraded-run flagging                       | 2026-08-09 | Accepted                            |
| [0051](0051-rdap-consensus-rescue-and-probe.md)                 | RDAP consensus rescue leg and startup probe — closure of ADR-0050 gaps                                         | 2026-08-10 | Accepted                            |
| [0052](0052-whois-distributed-rate-limit.md)                     | WHOIS distributed rate-limit parity — `whois` Redis namespace, per-TLD buckets, per-tenant fair share           | 2026-08-10 | Accepted                            |
| [0053](0053-billing-loop-completion.md)                         | Billing loop completion — Team checkout, status-aware usage enforcement, trial-once                            | 2026-08-12 | Proposed                            |
| [0054](0054-pitr-backup-strategy.md)                            | Point-in-time recovery for the Cloud stack — WAL archiving and restore playbook                               | 2026-08-12 | Accepted                            |
| [0055](0055-evidence-anchored-value.md)                         | Evidence-anchored expectedValue — value follows comparables, cap becomes an operator preference                | 2026-08-12 | Accepted                            |
| [0056](0056-anonymous-trademark-budget.md)                       | Anonymous trademark budget isolation — dedicated fail-open budget for public valuations, shared pipeline buckets untouched | 2026-08-13 | Accepted                            |

## Conventions

- Numbering is sequential and zero-padded (`NNNN-title-with-dashes.md`).
- Status is one of `Proposed`, `Accepted`, `Superseded`, `Deprecated`.
- ADRs are immutable once Accepted. A change of mind produces a new ADR
  that supersedes the old one — never an edit in place.
- The MADR 4.0.0 template is the source of truth for ADR structure.
  See `.claude/skills/adr/template.md` for the canonical form.
- **ADR-0001 through ADR-0024** document the original single-user, MIT-licensed,
  SQLite-based architecture. These decisions remain valid for the community
  edition (self-hosted, single-user).
- **ADR-0025 through ADR-0030** document the SaaS transition: license change,
  monetisation, multi-tenancy, PostgreSQL, professional frontend, conversion
  features, and public namespace architecture. These decisions build upon
  the earlier foundation while superseding specific constraints (single-user,
  MIT, SQLite-only, CLI-first UI).
- ADR-0025 supersedes ADR-0018 on licensing. ADR-0026 supersedes ADR-0001
  on monetisation and user model. ADR-0027 supersedes ADR-0001 on database
  and ADR-0005 on schema strategy. ADR-0028 supersedes ADR-0001 on frontend
  priority. ADR-0029 and ADR-0030 define the public-facing surface and
  conversion mechanics for DOMINUS Cloud.

## How to write a new ADR

Run `/adr <decision-title>` and follow the prompts. The skill enforces
the MADR format, requires at least 2 considered alternatives, and
updates this index on completion.
