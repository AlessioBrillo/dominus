# ADR-0024: Portfolio P&L Tracking and Analytics Frontend

## Metadata

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| **Status**     | Accepted                               |
| **Date**       | 2026-06-18                             |
| **Authors**    | AlessioBrillo                          |
| **Deciders**   | AlessioBrillo                          |
| **Supersedes** | N/A                                    |
| **Relates to** | ADR-0001, ADR-0007, ADR-0008, ADR-0020 |
| **Project**    | DOMINUS                                |

## Context

DOMINUS v0.3.0 has a complete investment feedback loop: pipeline → scoring → portfolio → outcomes → backtest → weight tuning. Every technical component is in place to acquire, hold, track, and sell domains. However, the system lacks an answer to the single most important question an investor asks: **"Am I making or losing money?"**

Before this ADR, the data required to compute the answer existed but was fragmented:

1. **Acquisition costs** lived in `portfolio_entries.acquisition_cost` and `bids.won_price_eur`.
2. **Renewal costs** lived in `portfolio_entries.renewal_cost` (annual).
3. **Sale proceeds** lived in `outcomes.sale_price_eur` (only for `sold` type).
4. **Prediction accuracy** (MAE, bias, confusion matrix) was available via CLI-only `dominus analytics` and the `/api/v1/analytics/accuracy` endpoint, but no frontend page existed to visualise it.

The operator had to manually join these data sources — using raw SQL or a spreadsheet — to compute portfolio P&L, ROI, holding costs, and prediction accuracy trends.

## Decision Drivers

1. **P&L visibility** — The operator must be able to see total investment, total returns, net P&L, ROI, and holding costs in a single dashboard view, without manual data joins.

2. **Per-domain granularity** — Beyond aggregate numbers, the operator needs a per-domain breakdown showing acquisition cost, renewal costs paid, sale price, net P&L, and holding period — sorted by profitability.

3. **Time-series trends** — Monthly cash flow (investment outflows vs. return inflows) must be visible to understand portfolio timing and liquidity.

4. **Accuracy metrics in the frontend** — The existing `PredictionAccuracyAnalyzer` data (MAE, bias, confusion matrix, calibration) must be surfaced in the frontend so the operator can assess scoring engine quality without switching to the CLI.

5. **Outcome cost basis** — Outcomes must optionally carry `acquisition_cost_eur` and `total_renewal_cost_eur` so future P&L queries can distinguish cost basis per outcome event.

6. **Zero-cost mandate** — No new infrastructure. All computation must use existing SQLite with zero external dependencies.

## Considered Options

### Option A: Backend P&L Service + API + Frontend Page (CHOSEN)

A `PnlService` class that reads from `portfolio_entries` and `outcomes`, computes aggregate/per-domain/monthly P&L, and exposes it via `GET /api/v1/analytics/pnl`. A new Analytics frontend page displays both P&L data and existing accuracy metrics in a tabbed layout.

**Advantages:**

- Single source of truth: P&L computation lives in the backend, not duplicated across CLI and frontend.
- Reuses existing `/api/v1/analytics/accuracy` endpoint for accuracy data — no new accuracy endpoint needed.
- Frontend page serves as the single destination for all performance metrics.
- Cost columns on `outcomes` are additive: existing records default to NULL, queries degrade gracefully.
- Zero new infrastructure: no new tables, no external services.

**Disadvantages:**

- Requires a small schema migration (2 columns on `outcomes`).
- P&L is point-in-time: it does not automatically update as new outcomes are recorded (the operator re-fetches).

**Cost Implications:** ~1 engineering day. Zero operational cost.

**Risk Assessment:** Low. Schema change is additive (new nullable columns). The P&L computation is read-only.

---

### Option B: CLI-Only P&L Report (REJECTED)

Add a `dominus portfolio pnl` CLI command that queries the same data and prints a formatted table.

**Advantages:**

- No frontend changes required.
- Faster to implement.

**Disadvantages:**

- Inconsistent with DOMINUS v0.3.x direction of providing a web dashboard for daily operations.
- CLI output is not persistent, not interactive, and not suitable for trend visualisation.
- Duplicates the same work when a frontend page is eventually needed.

**Risk Assessment:** Low, but misses the opportunity to close the feedback loop in the primary UI.

---

### Option C: Frontend-Only P&L Computation (REJECTED)

Fetch all portfolio entries and outcomes to the browser and compute P&L client-side in JavaScript.

**Advantages:**

- No backend changes needed.
- Instant feedback without API round-trips for computation.

**Disadvantages:**

- Leaks the entire outcome/portfolio dataset to the browser unconditionally.
- Inconsistent computation: if the formula changes, old cached pages show stale numbers.
- Cannot easily aggregate or anonymise data.
- Duplicates business logic (P&L formula) across client and server.

**Risk Assessment:** Medium. Data exposure and logic duplication make this the weakest option.

---

## Decision

**Chosen option: Option A — Backend P&L Service + API + Frontend Page**

Rationale:

1. **Single source of truth**: `PnlService` is the only place P&L is computed.
2. **Reuses existing endpoint**: Accuracy data is already served by `GET /api/v1/analytics/accuracy`; the new `GET /api/v1/analytics/pnl` endpoint complements it.
3. **Additive schema change**: Two nullable columns on `outcomes` do not break existing queries.
4. **Frontend as primary UI**: The Analytics page becomes the go-to destination for performance questions, reducing reliance on CLI.
5. **Extensible**: Future enhancements (e.g., P&L by TLD, by registrar, by year) are additions to the same service and endpoint.

## Consequences

### Positive

- The operator can see portfolio P&L and prediction accuracy in one frontend page.
- `acquisition_cost_eur` and `total_renewal_cost_eur` on `outcomes` enable per-outcome cost tracking for future enhancements.
- Monthly cash flow visualisation helps the operator understand portfolio timing.
- The Analytics page navbar entry (`/analytics`) is consistent with DOMINUS's decision-first UX pattern.

### Negative

- Outcome cost columns are NULL for existing records. The operator must backfill manually or the values must be inherited from the winning bid (future enhancement).
- P&L is read-only snapshot; the page must be refreshed to see new outcomes reflected.
- Monthly trend data is computed from insertion/acquisition dates; backdated entries may skew periods (acceptable at DOMINUS scale).

### Compliance and Security Implications

- All P&L data is behind the existing API authentication (ADR-0017).
- No new PII or sensitive data: domain names and EUR amounts are the same data already exposed via other endpoints.
- The cost basis on outcomes enables more detailed financial tracking but does not introduce new data categories.

### Migration and Monitoring Plan

1. **Schema migration**: `ALTER TABLE outcomes ADD COLUMN acquisition_cost_eur REAL`, `ALTER TABLE outcomes ADD COLUMN total_renewal_cost_eur REAL` (done).
2. **PnlService**: Read-only service computing aggregate/per-domain/trend P&L from `portfolio_entries` + `outcomes`.
3. **API endpoint**: `GET /api/v1/analytics/pnl` returns `PnlReport`.
4. **Frontend page**: New `/analytics` route with P&L tab (summary cards, per-domain table, monthly trend bar chart) and Accuracy tab (existing accuracy metrics + confusion matrix + calibration).
5. **Backfill**: Existing outcomes will have NULL cost columns. The operator can set them via the existing outcome recording CLI/API when the cost is known.

---

_This ADR was created following the MADR 4.0.0 standard. Template: `.claude/skills/adr/template.md`._
