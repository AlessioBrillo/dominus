# From a closeout list to a buy decision

DOMINUS answers one question per candidate: **buy or pass**. This guide takes a
list of expiring or closeout domains from a marketplace export to that answer.

## 1. Prepare the list

Export the closeout/expired list from your marketplace as CSV. Columns are
header-driven and order is free; unknown columns are ignored:

```csv
domain,age,backlinks,wayback
vintagecoffee.com,14,420,180
oldmaproom.net,9,75,40
```

- `age` is the domain age in years, `backlinks` the referring link count,
  `wayback` the number of archive snapshots. DOMINUS does not fetch age or
  backlinks itself: they come from your export. Wayback history is also fetched
  automatically when `WAYBACK_ENABLED=true`.
- A sample lives in `examples/closeout-sample.csv`.

## 2. Run the pipeline

Dashboard: **Candidates -> Run pipeline**, or from the CLI:

```bash
dominus run --closeout-csv ./closeouts.csv          # async by default
dominus run --closeout-csv ./closeouts.csv --sync   # wait for the result
```

After candidates are generated, each domain passes through the filter stages
below, in order. A domain that fails a stage is dropped there and never reaches
the next:

| Stage              | Drops a domain when...                                     |
| ------------------ | ---------------------------------------------------------- |
| DNS pre-filter     | it is clearly registered                                   |
| RDAP confirmation  | it is registered, or is a registry **premium** name        |
| Scoring            | confidence is below the floor (a hard pass)                |
| **Trademark gate** | it matches a registered trademark (USPTO / EUIPO) — always |

## 3. Read a candidate

Open **Candidates** and pick the run. For each candidate you get:

- `expected_value` — what the engine thinks the name is worth. It is built to be
  **more conservative** than commercial appraisers.
- `confidence` — how much evidence backs that value. Below 0.3 it is a pass
  regardless of the value.
- `suggested_buy_max` — the most to pay (a fraction of `expected_value`). Never
  exceed it.
- `suggested_list_price` — where to list it after purchase.
- The trademark verdict and the signals behind the score (intrinsic, commercial,
  market, expiry).

A candidate is **recommended** only when it passes every stage, including the
trademark gate. A trademark match blocks it even if the auction is about to end.

## 4. Buy

1. Open **Buy** (or `dominus buy check <domain>`): the pre-flight re-checks
   availability, the trademark gate and your budget, and quotes the price.
2. Buy at the registrar. Registrar purchases are manual by default; the
   Cloudflare registrar can be wired for in-app purchase.
3. Add the domain to the portfolio so it gets a renewal clock and a verdict
   (see [Portfolio: keep, drop or reprice](portfolio-keep-drop.md)).

## Tuning

If recommendations feel off, record real outcomes and run the backtest
([guide](portfolio-keep-drop.md#close-the-loop-outcomes-and-weights)); weights
are tuned against real comparable sales, not intuition.
