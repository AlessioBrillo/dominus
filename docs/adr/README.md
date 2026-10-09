# Architecture Decision Records

This directory contains all Architecture Decision Records (ADRs) for DOMINUS.
ADRs document the _why_ behind non-obvious design choices so future
maintainers (including future-you) can re-derive the trade-offs without
re-running the original arguments.

> The table below is **generated** from the ADR files (`npm run adr:index`) and
> checked in CI (`npm run adr:index:check`). Edit an ADR's own status, never
> this table.

| ADR                                                            | Title                                                                                                | Date       | Status                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------- |
| [0001](0001-project-architecture.md)                           | Project Architecture and Technology Decisions                                                        | 2026-06-08 | Superseded (see ADR-0026, ADR-0027) |
| [0002](0002-scoring-engine-design.md)                          | Scoring Engine Design and Conservatism Principle                                                     | 2026-06-08 | Accepted (retrospective)            |
| [0003](0003-pipeline-stage-separation.md)                      | Pipeline Stage Separation                                                                            | 2026-06-08 | Accepted (retrospective)            |
| [0004](0004-provider-abstraction-pattern.md)                   | Provider Abstraction Pattern                                                                         | 2026-06-08 | Accepted (retrospective)            |
| [0005](0005-sqlite-schema-and-migrations.md)                   | SQLite Schema and Migration Strategy                                                                 | 2026-06-08 | Accepted (retrospective)            |
| [0006](0006-trademark-gate-mandate.md)                         | Trademark Gate Mandate                                                                               | 2026-06-08 | Accepted (retrospective)            |
| [0007](0007-backtest-signals-schema.md)                        | backtest_signals schema for prediction-vs-reality audit                                              | 2026-06-06 | Accepted                            |
| [0008](0008-backtest-engine.md)                                | Backtest engine — joining predictions to outcomes with point-in-time correctness                     | 2026-06-06 | Accepted                            |
| [0009](0009-weight-recalibration-suggestion.md)                | Weight recalibration suggestion with manual approval                                                 | 2026-06-06 | Accepted                            |
| [0010](0010-rescore-bridge-decision.md)                        | Portfolio rescore bridge — why DNS/RDAP are bypassed on owned domains                                | 2026-06-06 | Accepted (retrospective)            |
| [0011](0011-pipeline-runs-schema.md)                           | pipeline_runs schema — durable history of every pipeline execution                                   | 2026-06-07 | Accepted                            |
| [0012](0012-trademark-matching-policy.md)                      | Trademark matching policy and `.com` USPTO fallback                                                  | 2026-06-07 | Accepted                            |
| [0013](0013-domain-parsing-consolidation.md)                   | Domain parsing consolidation — canonical SLD/TLD across scoring and trademark gate                   | 2026-06-07 | Accepted                            |
| [0014](0014-euipo-api-migration.md)                            | EUIPO provider migration to Trademark Search 1.1.0 (RSQL + X-IBM-Client-Id)                          | 2026-06-07 | Accepted                            |
| [0015](0015-psl-parser-adoption.md)                            | Adopt full Public Suffix List via `psl` npm Package                                                  | 2026-06-08 | Accepted                            |
| [0016](0016-registrar-abstraction.md)                          | Registrar Provider Abstraction                                                                       | 2026-06-08 | Accepted                            |
| [0017](0017-api-authentication.md)                             | API Authentication                                                                                   | 2026-06-08 | Accepted                            |
| [0018](0018-open-source-architecture.md)                       | Open-Source Architecture                                                                             | 2026-06-09 | Superseded (see ADR-0025, ADR-0026) |
| [0019](0019-auto-weight-tuning-loop.md)                        | Closed-Loop Auto Weight Tuning                                                                       | 2026-06-09 | Accepted                            |
| [0020](0020-scoring-confidence-formula.md)                     | Scoring Confidence Formula and Intrinsic Quality Coupling                                            | 2026-06-11 | Accepted                            |
| [0021](0021-provider-resilience-and-observability.md)          | Provider Resilience and Observability Layer                                                          | 2026-06-12 | Accepted                            |
| [0022](0022-backup-and-operations.md)                          | Database Backup Strategy and Production Operations                                                   | 2026-06-13 | Accepted                            |
| [0023](0023-job-queue-worker-pool-architecture.md)             | Job Queue + Worker Pool Architecture                                                                 | 2026-06-16 | Accepted                            |
| [0024](0024-portfolio-pnl-analytics.md)                        | Portfolio P&L Tracking and Analytics Frontend                                                        | 2026-06-18 | Accepted                            |
| [0025](0025-license-change-agpl-commercial.md)                 | License Change — MIT to AGPL v3 + Commercial                                                         | 2026-06-18 | Accepted                            |
| [0026](0026-monetization-and-saas-model.md)                    | Monetization and SaaS Model                                                                          | 2026-06-18 | Accepted                            |
| [0027](0027-saas-architecture-multi-tenant.md)                 | SaaS Architecture — Multi-Tenancy, Database, and Authentication                                      | 2026-06-18 | Accepted                            |
| [0028](0028-frontend-architecture-professional-dashboard.md)   | Frontend Architecture — Professional SaaS Dashboard                                                  | 2026-06-18 | Accepted                            |
| [0029](0029-conversion-driven-features.md)                     | Conversion-Driven Features for DOMINUS Cloud                                                         | 2026-06-21 | Accepted                            |
| [0030](0030-public-namespace-architecture.md)                  | Public Namespace Architecture                                                                        | 2026-06-26 | Accepted                            |
| [0031](0031-production-hardening.md)                           | Production Hardening — CSP, Auth DI, Rate Limiting, Retry Consolidation                              | 2026-06-26 | Accepted                            |
| [0032](0032-cloud-authentication.md)                           | Cloud Authentication — External Identity Provider (Auth0)                                            | 2026-06-26 | Superseded (see ADR-0062)           |
| [0033](0033-cloud-redis-infrastructure.md)                     | Cloud Redis Infrastructure — Distributed Rate Limiting, Job Queue, and Cache                         | 2026-06-26 | Accepted                            |
| [0034](0034-multi-tenant-data-model.md)                        | Multi-Tenant Data Model — Tenant ID Column + PostgreSQL Row-Level Security                           | 2026-06-26 | Accepted                            |
| [0035](0035-rdap-authoritative-bootstrap.md)                   | RDAP Authoritative Bootstrap Resolution                                                              | 2026-08-02 | Accepted                            |
| [0036](0036-license-and-ip-protection.md)                      | License and IP Protection Hardening                                                                  | 2026-08-01 | Accepted                            |
| [0037](0037-pipeline-run-integrity-at-scale.md)                | Pipeline Run Integrity at Scale                                                                      | 2026-08-04 | Accepted                            |
| [0038](0038-tenant-isolation.md)                               | Multi-Tenant Tenant Isolation Model                                                                  | 2026-08-07 | Accepted                            |
| [0038](0038-usage-enforcement.md)                              | Usage Enforcement                                                                                    | 2026-08-07 | Accepted                            |
| [0039](0039-dns-consensus-degradation-policy.md)               | DNS Consensus Failure Policy                                                                         | 2026-08-07 | Superseded by ADR-0072 and ADR-0075 |
| [0040](0040-dns-consensus-fallback-parity.md)                  | DNS Consensus Fallback Parity                                                                        | 2026-08-07 | Superseded by ADR-0072 and ADR-0075 |
| [0041](0041-provider-fair-share.md)                            | Distributed Per-Tenant Provider Fair Share                                                           | 2026-08-07 | Accepted                            |
| [0042](0042-provider-dns-private-recursor.md)                  | Private Recursor for the DNS Consensus Secondary                                                     | 2026-08-07 | Superseded by ADR-0072 and ADR-0075 |
| [0043](0043-configurable-public-rate-limits.md)                | Configurable Per-IP Rate Limits on the Public Namespace                                              | 2026-08-07 | Accepted                            |
| [0044](0044-dns-consensus-budget-and-doh-pool.md)              | DNS Consensus Budget and DoH Keep-Alive Pooling                                                      | 2026-08-07 | Superseded by ADR-0072 and ADR-0075 |
| [0045](0045-dns-consensus-tertiary-leg.md)                     | DNS Consensus Third Leg                                                                              | 2026-08-08 | Superseded by ADR-0072 and ADR-0075 |
| [0046](0046-image-supply-chain-pinning.md)                     | Immutable Image Supply Chain                                                                         | 2026-08-08 | Accepted                            |
| [0047](0047-doh-json-legs-verified.md)                         | Live-Verified DoH Legs — Provider Endpoints and RFC 8484 Wire                                        | 2026-08-08 | Superseded by ADR-0072 and ADR-0075 |
| [0048](0048-resolver-groups-wire-format.md)                    | Custom Resolver Groups Accept the DoH Wire Format (ADR-0047 Gap)                                     | 2026-08-08 | Superseded by ADR-0072 and ADR-0075 |
| [0049](0049-rdap-transport-parity.md)                          | RDAP Transport Parity — Keep-Alive Pooling and Connection Budget                                     | 2026-08-09 | Accepted                            |
| [0050](0050-rdap-consensus.md)                                 | RDAP Consensus — Independent Second Opinion on Availability                                          | 2026-08-09 | Accepted                            |
| [0051](0051-rdap-consensus-rescue-and-probe.md)                | RDAP Consensus Rescue Leg and Startup Probe — Closure of ADR-0050 Gaps                               | 2026-08-10 | Accepted                            |
| [0052](0052-whois-distributed-rate-limit.md)                   | WHOIS Distributed Rate-Limit Parity                                                                  | 2026-08-10 | Accepted                            |
| [0053](0053-billing-loop-completion.md)                        | Billing Loop Completion — Team Checkout and Status-Aware Enforcement                                 | 2026-08-12 | Accepted                            |
| [0054](0054-pitr-backup-strategy.md)                           | Point-in-Time Recovery Backup Strategy                                                               | 2026-08-12 | Accepted                            |
| [0055](0055-evidence-anchored-value.md)                        | Evidence-Anchored expectedValue                                                                      | 2026-08-12 | Accepted                            |
| [0056](0056-anonymous-trademark-budget.md)                     | Anonymous Trademark Budget Isolation                                                                 | 2026-08-13 | Accepted                            |
| [0057](0057-tenant-lifecycle-management.md)                    | Tenant Lifecycle Management (Admin Operations Loop)                                                  | 2026-08-13 | Accepted                            |
| [0058](0058-rdap-gate-parity.md)                               | RDAP Gate Parity — Consensus Default-On, Resilient Bootstrap, Origin-Overlap Guard                   | 2026-08-14 | Accepted                            |
| [0059](0059-dns-circuit-breaker-and-strictness.md)             | DNS Consensus Strictness and Per-Endpoint Circuit Breakers                                           | 2026-08-16 | Superseded by ADR-0072 and ADR-0075 |
| [0060](0060-rdap-origin-guard-fail-closed.md)                  | RDAP Origin-Guard Fail-Closed — a Broken Resolver Never Consults the Second Leg                      | 2026-08-17 | Accepted                            |
| [0061](0061-release-migrate-before-roll.md)                    | Release Migrate-Before-Roll — Explicit Schema Migrations with a Dedicated Timeout                    | 2026-08-18 | Accepted                            |
| [0062](0062-enterprise-sso.md)                                 | Enterprise SSO — OIDC Authorization Code + PKCE with backend session cookies                         | 2026-08-19 | Accepted                            |
| [0063](0063-dns-consensus-independence-topology.md)            | DNS Consensus Independence — topology-aware disjointness                                             | 2026-08-20 | Superseded by ADR-0072 and ADR-0075 |
| [0064](0064-dns-slo-observability.md)                          | DNS SLO Observability — per-leg latency histograms and tertiary rescue in the production topology    | 2026-08-20 | Accepted                            |
| [0065](0065-dns-privacy-and-redundancy.md)                     | DNS Privacy Mode and Tertiary Leg Redundancy                                                         | 2026-08-20 | Superseded by ADR-0072 and ADR-0075 |
| [0068](0068-dns-tertiary-dual-redundancy.md)                   | DNS Tertiary Dual-Redundancy for SPOF Elimination                                                    | 2026-08-31 | Superseded by ADR-0072 and ADR-0075 |
| [0069](0069-dns-secondary-dual-redundancy.md)                  | DNS Secondary Dual-Redundancy for Consensus Gate Resilience                                          | 2026-09-06 | Superseded by ADR-0072 and ADR-0075 |
| [0070](0070-afternic-listing-provider.md)                      | Afternic Listing Provider and Trademark-Gated Publishing                                             | 2026-09-06 | Superseded by ADR-0082              |
| [0071](0071-sedo-listing-provider.md)                          | Sedo Listing Provider and Sell-Side Correctness Fixes                                                | 2026-09-07 | Superseded by ADR-0082              |
| [0072](0072-dns-consensus-revalidation-hardening.md)           | DNS Consensus Revalidation Hardening — Strict Anycast Overlap Veto with System Resolver Independence | 2026-09-07 | Accepted                            |
| [0073](0073-dnssec-per-query-validation.md)                    | Per-Query DNSSEC Validation with @relaycorp/dnssec                                                   | 2026-09-23 | Superseded by ADR-0082              |
| [0074](0074-rdap-consensus-probe-resilience.md)                | RDAP Consensus Probe Resilience with Retry and Fail-Open                                             | 2026-09-23 | Superseded by ADR-0077              |
| [0075](0075-dns-unbound-single-source-completion.md)           | 0075-dns-unbound-single-source-completion.md                                                         | 2026-09-24 | Accepted                            |
| [0076](0076-dns-community-fallback.md)                         | 0076-dns-community-fallback.md                                                                       | 2026-09-26 | Accepted                            |
| [0077](0077-rdap-consensus-per-tld-authoritative-secondary.md) | RDAP Consensus Per-TLD Authoritative Secondary Leg with Cloud-Mode Fail-Open Default                 | 2026-09-26 | Accepted                            |
| [0078](0078-dns-resolver-resilience-hardening.md)              | DNS Resolver Resilience Hardening — Quorum, DNSSEC State Persistence, Cache Purge on Validation Loss | 2026-09-28 | Accepted                            |
| [0079](0079-dns-fallback-fail-closed-hardening.md)             | DNS Fallback Fail-Closed Hardening — Config Honesty, Provenance Truth, Bulk Index Safety             | 2026-10-01 | Accepted                            |
| [0080](0080-db-connection-topology.md)                         | DB Connection Topology — Single Writer, Explicit Lifecycle, Read-Your-Write                          | 2026-10-02 | Proposed                            |
| [0081](0081-operator-role-and-team-invitations.md)             | Platform operator role, SSO tenant resolution and team invitations                                   | 2026-10-08 | Accepted                            |
| [0082](0082-removal-of-unimplemented-features.md)              | Remove features that were declared but never worked                                                  | 2026-10-08 | Accepted                            |

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
  conversion mechanics for DOMINUS Cloud. ADR-0062 supersedes ADR-0032 on
  cloud authentication, ratifying the interactive SSO flow.

## How to write a new ADR

Run `/adr <decision-title>` and follow the prompts. The skill enforces
the MADR format, requires at least 2 considered alternatives, and
updates this index on completion.

## Numbering note

ADR-0038 was assigned twice in the same day: `0038-usage-enforcement.md`
and `0038-tenant-isolation.md` (both 2026-08-07, both Accepted). The
filenames and links are kept as-is — renumbering merged ADRs would break
every reference across docs, commits, and PRs. Subsequent ADRs continue
from 0039; the numbering gap is a registry quirk, not a missing record.

ADR-0066 and ADR-0067 are not in the repository: git history never contained a
file for either number. ADR-0072 and `src/types/metrics.ts` still cite
ADR-0066, so treat that reference as dangling rather than as a record to find.
