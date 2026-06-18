# Architecture Decision Records

This directory contains all Architecture Decision Records (ADRs) for DOMINUS.
ADRs document the _why_ behind non-obvious design choices so future
maintainers (including future-you) can re-derive the trade-offs without
re-running the original arguments.

| ADR                                                   | Title                                                                              | Date       | Status                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- | ------------------------ |
| [0001](0001-project-architecture.md)                  | Project architecture and technology decisions                                      | 2026-06-08 | Accepted (retrospective) |
| [0002](0002-scoring-engine-design.md)                 | Scoring engine design and conservatism principle                                   | 2026-06-08 | Accepted (retrospective) |
| [0003](0003-pipeline-stage-separation.md)             | Pipeline stage separation                                                          | 2026-06-08 | Accepted (retrospective) |
| [0004](0004-provider-abstraction-pattern.md)          | Provider abstraction pattern                                                       | 2026-06-08 | Accepted (retrospective) |
| [0005](0005-sqlite-schema-and-migrations.md)          | SQLite schema and migration strategy                                               | 2026-06-08 | Accepted (retrospective) |
| [0006](0006-trademark-gate-mandate.md)                | Trademark gate mandate                                                             | 2026-06-08 | Accepted (retrospective) |
| [0007](0007-backtest-signals-schema.md)               | backtest_signals schema for prediction-vs-reality audit                            | 2026-06-06 | Accepted                 |
| [0008](0008-backtest-engine.md)                       | Backtest engine — joining predictions to outcomes with point-in-time correctness   | 2026-06-06 | Accepted                 |
| [0009](0009-weight-recalibration-suggestion.md)       | Weight recalibration suggestion with manual approval                               | 2026-06-06 | Accepted                 |
| [0010](0010-rescore-bridge-decision.md)               | Portfolio rescore bridge — why DNS/RDAP are bypassed on owned domains              | 2026-06-06 | Accepted (retrospective) |
| [0011](0011-pipeline-runs-schema.md)                  | pipeline_runs schema — durable history of every pipeline execution                 | 2026-06-07 | Accepted                 |
| [0012](0012-trademark-matching-policy.md)             | Trademark matching policy and `.com` USPTO fallback                                | 2026-06-07 | Accepted                 |
| [0013](0013-domain-parsing-consolidation.md)          | Domain parsing consolidation — canonical SLD/TLD across scoring and trademark gate | 2026-06-07 | Accepted                 |
| [0014](0014-euipo-api-migration.md)                   | EUIPO provider migration to Trademark Search 1.1.0 (RSQL + X-IBM-Client-Id)        | 2026-06-07 | Accepted                 |
| [0015](0015-psl-parser-adoption.md)                   | Adopt full Public Suffix List via `psl` npm Package                                | 2026-06-07 | Accepted                 |
| [0016](0016-registrar-abstraction.md)                 | Registrar provider abstraction                                                     | 2026-06-08 | Accepted                 |
| [0017](0017-api-authentication.md)                    | API authentication                                                                 | 2026-06-08 | Accepted                 |
| [0018](0018-open-source-architecture.md)              | Open-source architecture and forkability                                           | 2026-06-09 | Accepted                 |
| [0019](0019-auto-weight-tuning-loop.md)               | Closed-loop auto weight tuning                                                     | 2026-06-09 | Accepted                 |
| [0020](0020-scoring-confidence-formula.md)            | Scoring confidence formula and intrinsic quality coupling                          | 2026-06-11 | Accepted                 |
| [0021](0021-provider-resilience-and-observability.md) | Provider resilience and observability layer                                        | 2026-06-12 | Accepted                 |
| [0022](0022-backup-and-operations.md)                 | Backup and operations                                                              | 2026-06-13 | Accepted                 |
| [0023](0023-job-queue-worker-pool-architecture.md)    | Job queue and worker pool architecture                                             | 2026-06-16 | Accepted                 |
| [0024](0024-portfolio-pnl-analytics.md)               | Portfolio P&L tracking and analytics frontend                                      | 2026-06-18 | Accepted                 |

## Conventions

- Numbering is sequential and zero-padded (`NNNN-title-with-dashes.md`).
- Status is one of `Proposed`, `Accepted`, `Superseded`, `Deprecated`.
- ADRs are immutable once Accepted. A change of mind produces a new ADR
  that supersedes the old one — never an edit in place.
- The MADR 4.0.0 template is the source of truth for ADR structure.
  See `.claude/skills/adr/template.md` for the canonical form.
- All ADRs must be consistent with earlier ADRs. The foundational decisions
  (ADR-0001 through ADR-0006) document the architecture principles that all
  subsequent ADRs build upon.

## How to write a new ADR

Run `/adr <decision-title>` and follow the prompts. The skill enforces
the MADR format, requires at least 2 considered alternatives, and
updates this index on completion.
