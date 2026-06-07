# Architecture Decision Records

This directory contains all Architecture Decision Records (ADRs) for DOMINUS.
ADRs document the *why* behind non-obvious design choices so future
maintainers (including future-you) can re-derive the trade-offs without
re-running the original arguments.

| ADR | Title | Date | Status |
|-----|-------|------|--------|
| [0007](0007-backtest-signals-schema.md) | backtest_signals schema for prediction-vs-reality audit | 2026-06-06 | Accepted |
| [0008](0008-backtest-engine.md) | Backtest engine — joining predictions to outcomes with point-in-time correctness | 2026-06-06 | Accepted |
| [0009](0009-weight-recalibration-suggestion.md) | Weight recalibration suggestion with manual approval | 2026-06-06 | Accepted |
| [0010](0010-rescore-bridge-decision.md) | Portfolio rescore bridge — why DNS/RDAP are bypassed on owned domains | 2026-06-06 | Accepted (retrospective) |
| [0011](0011-pipeline-runs-schema.md) | pipeline_runs schema — durable history of every pipeline execution | 2026-06-07 | Accepted |
| [0012](0012-trademark-matching-policy.md) | Trademark matching policy and `.com` USPTO fallback | 2026-06-07 | Accepted |
| [0013](0013-domain-parsing-consolidation.md) | Domain parsing consolidation — canonical SLD/TLD across scoring and trademark gate | 2026-06-07 | Accepted |
| [0014](0014-euipo-api-migration.md) | EUIPO provider migration to Trademark Search 1.1.0 (RSQL + X-IBM-Client-Id) | 2026-06-07 | Accepted |
| [0015](0015-psl-parser-adoption.md) | Adopt full Public Suffix List via `psl` npm Package | 2026-06-07 | Proposed |

## Conventions

- Numbering is sequential and zero-padded (`NNNN-title-with-dashes.md`).
- Status is one of `Proposed`, `Accepted`, `Superseded`, `Deprecated`.
- ADRs are immutable once Accepted. A change of mind produces a new ADR
  that supersedes the old one — never an edit in place.
- The MADR 4.0.0 template is the source of truth for ADR structure.
  See `.claude/skills/adr/template.md` for the canonical form.
- All ADRs must be consistent with `dominus-product-vision.md`.

## How to write a new ADR

Run `/adr <decision-title>` and follow the prompts. The skill enforces
the MADR format, requires at least 2 considered alternatives, and
updates this index on completion.
