# Data Sources and Provenance

DOMINUS consumes and produces data from several sources. This document
records where each dataset comes from, under which terms, and whether it may
be redistributed. This matters for the project's dual licensing (AGPL v3 +
commercial) and for compliance with third-party terms.

## Bundled (committed to the repository)

| Data | Location | Provenance | Redistribution |
|------|----------|------------|----------------|
| Keyword sample | `examples/keywords-sample.json` | **Synthetic** sample of search volume / CPC / competition | Safe — fictional values, no third-party data |
| Comps sample | `examples/comps-sample.csv` | **Synthetic** sample of domain sales | Safe — fictional values, no third-party data |
| Closeout sample | `examples/closeout-sample.csv` | Synthetic import-format example | Safe |
| TLD bonus example | `examples/tld-bonuses.json` | Synthetic example of the TLD bonus config | Safe |
| Weights example | `examples/weights-override.json` | Synthetic example of scoring weight overrides | Safe |
| Parking IP ranges | `src/providers/dns/parking-ips.json` | Public IP range facts (ARIN / RIR allocations) | Facts are not copyrightable |

## Fetched at runtime

| Data | Source | Terms |
|------|--------|-------|
| Domain availability / premium | RDAP bootstrap (rdap.org, IANA `dns.json`, per-registry servers) | Public infrastructure; service terms of each registry apply; no redistribution of responses |
| Trademark matches | USPTO public API, EUIPO OAuth2 API | Public government data; no redistribution restrictions on results |
| Wayback history | web.archive.org CDX API | Archive.org terms of service |

## User-provided (never committed)

| Data | Location | Notes |
|------|----------|-------|
| Keyword volumes | `KEYWORD_DATA_PATH` (default `examples/keywords-sample.json`) | If real Google Keyword Planner data is used, Google Ads Terms of Service **prohibit redistribution**. Keep such files out of the repository (`data/` is gitignored). |
| Comparable sales | `COMPS_DATA_PATH` (default `examples/comps-sample.csv`) | If NameBio exports are used, NameBio's data terms require attribution: https://namebio.com/terms |
| User databases | `data/dominus.db` | User-owned; gitignored |

## Policy

1. The repository ships **only synthetic sample data** — never real keyword
   volumes, search trends, or third-party sales exports.
2. `data/` is gitignored and reserved for user data; committing files from
   `data/` is a CI-reviewed mistake.
3. New bundled datasets require a provenance entry in this file and in
   `THIRD-PARTY-NOTICES.md` before merge.
