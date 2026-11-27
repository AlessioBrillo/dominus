# ADR-0115: The mobile value contract is the method, not the estimate

## Metadata

| Field          | Value                                                                 |
| -------------- | --------------------------------------------------------------------- |
| **Status**     | Accepted                                                              |
| **Date**       | 2026-11-27                                                            |
| **Authors**    | Alessio Brillo                                                        |
| **Deciders**   | Alessio Brillo                                                        |
| **Supersedes** | —                                                                     |
| **Relates to** | ADR-0002, ADR-0111, ADR-0114                                          |

## Context

The owner chose a €0 monthly data budget for the public launch. The scoring
engine has always been explicit about evidence: with the bundled sample data
`examples/comps-sample.csv` and `examples/keywords-sample.json`, the market
signal exists but is **synthetic and sparse**. `ScoringEngine` scales a market
weight by `dataDensity` and lowers `confidence` when signals are unavailable;
the recommendation threshold is then computed from the covered weight. This is
the conservatism principle of ADR-0002 working as designed.

The problem is presentation, not the engine. A phone screen that shows
"Expected value €4,200" next to a "BUY" badge implies an appraisal the product
cannot support. The ICP (50–500 domains) is exactly the audience that will
notice.

## Decision

1. The mobile product sells the **decision method**, not a predicted price:
   the maximum one should pay, the trademark verdict, and the renewal
   verdict. The score is shown with its evidence state, never alone.
2. Every score surface renders `signalStatus` (ADR-0004 provider abstraction)
   with an explicit `available` / `not available` label. A domain scored on
   two of four signals says so. "Expected value" is labelled *estimate*,
   never *appraisal* or *investment advice*.
3. Public copy, store description and the landing page say what the tool does
   not do ("we do not tell you what it is worth") before saying what it does.
4. No new paid data source is introduced in this increment. `KEYWORD_PROVIDER`
   and `COMPS_PROVIDER` stay configurable; a real provider can be added behind
   the existing interfaces without changing this contract (ADR-0004).
5. `check:public-claims` remains the mechanical guard: a claim that the tool
   appraises, guarantees or advises is a gate failure.

## Considered alternatives

| Alternative                     | Why rejected                                                        |
| ------------------------------- | ------------------------------------------------------------------- |
| Hide confidence and show a price | Violates ADR-0002; a buyer would act on false precision.            |
| Buy a comparables feed          | The owner set a €0 data budget; the cost arrives before demand exists. |
| Launch only the CLI/community   | Misses the stated goal of a public mobile application.              |

## Consequences

- The UI work is copy and evidence display; the engine and its weights do not
  change, so backtest evidence stays comparable.
- Conversion depends on trust in the method, which must be earned through the
  design-partner cohort of `docs/releases/founding-cohort.md`.
- If willingness-to-pay interviews later support a data budget, a real comps
  provider can be enabled without revisiting this decision.
