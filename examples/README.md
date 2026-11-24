# Example data — synthetic fixtures, not market data

The files in this directory exist so that `dominus score <domain>` can be
demonstrated with no account, no API key and no network access. **They are
illustrative fixtures.** Nothing in them is a measurement of a real domain,
a real sale, or real keyword demand.

| File | What it is | Real data? |
|---|---|---|
| `keywords-sample.json` | A handful of term/volume/CPC rows with plausible values. | **No.** Illustrative only. |
| `comps-sample.csv` | A short list of domain names with prices and venues. The shape matches a NameBio export; the rows are fixtures. | **No.** Do not treat the prices as comparable sales. |
| `closeout-sample.csv` | Three domains with age, backlinks and Wayback counts, matching the header-driven closeout import format. | **No.** Illustrative only. |
| `sector-keywords.json` | An Italian keyword taxonomy used by candidate generation. Terms, not demand metrics. | Terms are real words; volume and CPC are **not** present. |
| `tld-bonuses.json`, `weights-override.json` | Configuration examples for local tuning. | Configuration, not observations. |

## Why this matters

The scoring engine reports a confidence and a list of signal statuses. With
fixture data, both describe the **fixture**, not the domain. A score produced
from these files is a demonstration of the engine's output format; it is not
an appraisal and it is not evidence that a domain is worth a particular
amount. The CLI prints the verdict and its sources so a reader can see which
signals contributed, and ADR-0002 requires the engine to stay conservative —
neither property turns synthetic input into a real valuation.

For a real run, supply your own data or configure a provider:

- `KEYWORD_PROVIDER` and `KEYWORD_DATA_PATH` — see `.env.example`;
- `COMPS_PROVIDER` and `COMPS_DATA_PATH` — see `.env.example`;
- the trademark gate always queries the configured trademark source, never
  the fixtures.

See [docs/data-sources.md](../docs/data-sources.md) for what the engine uses
in a real deployment and [ADR-0002](../docs/adr/0002-scoring-engine-design.md)
for the conservatism principle.
