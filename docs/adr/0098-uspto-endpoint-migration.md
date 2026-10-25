# ADR-0098: USPTO trademark search endpoint migration to prod-stage-v1-0-0

## Metadata

| Field          | Value                                                |
| -------------- | ---------------------------------------------------- |
| **Status**     | Accepted                                             |
| **Date**       | 2026-10-25                                           |
| **Authors**    | Alessio Brillo                                       |
| **Deciders**   | Alessio Brillo                                       |
| **Supersedes** | —                                                    |
| **Relates to** | ADR-0006, ADR-0012, ADR-0097, ADR-0014               |
| **Project**    | DOMINUS                                              |

## Context

On 2026-10-22, `POST https://tmsearch.uspto.gov/tmsearch` (the USPTO
Elasticsearch backend the `UsptoCasesProvider` used since v1.0.x) answers
HTTP 405 Method Not Allowed from Amazon S3: the path now serves the static
assets of the search site. The TSDR fallback (`tsdr.uspto.gov`) answers
429 Too Many Requests. Until a source answers, `dominus score` reports
`TM unverified` and never recommends a domain — correct and conservative,
but the community edition's front door cannot give a real answer on any
`.com`/`.us` domain.

The trademark gate is the one feature the product cannot be without
(Principle 6, ADR-0006). It must not degrade silently to a false `clear`,
and it must not stay `unverified` forever while a working source exists.

## Decision

Migrate `UsptoCasesProvider` to the backend the `tmsearch.uspto.gov`
search SPA actually talks to, discovered from
`https://tmsearch.uspto.gov/configuration.json`:

```
serviceUrlSearchElastic: https://tmsearch.uspto.gov/prod-stage-v1-0-0/
```

The path `https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch` accepts
the same Elasticsearch-style POST body (`match_phrase` on `WM`, `minimum_should_match`)
and answers HTTP 200 with JSON. Verified live on 2026-10-24 from this machine:
`nike` → 170 hits, 24 alive in the first 50 (reg. 1772987, status 800);
`vintagecoffee` → 0 hits; `dominus` → 67 hits, 15 alive.

The migration is a provider-level change only: the `TrademarkGate`,
the fail-closed posture, `STRICT_USPTO_TLDS`, the match detector, and all
callers are unchanged.

## Consequences

### Positive

- The gate answers again: `nike.com` → `blocked`; `vintagecoffee.com` →
  `clear`; `Recommended: YES` returns for domains that are genuinely clear.
- The response shape changed: fields are nested under `source` (current
  backend names: `wordmark`, `statusCode`, `statusDescription`, `alive`,
  `ownerName`, `registrationId`, `id`) instead of `_source` with
  `WM/ST/ON/SN/SN/RN`. Both envelopes are parsed so older mirrors keep
  working (dual-schema).
- `alive` replaces the `6-`/`7-`/`8-` status-prefix heuristic as the
  activity signal, with the prefix heuristic as fallback.
- `size: 100` plus a `_source`/`source` projection keeps responses ~30 KB
  instead of ~280 KB, so the decision profile stays under its ~2 s budget.
- Fail closed is preserved: any non-2xx, non-JSON, or unrecognized shape
  throws `ProviderError`; an empty result set is never manufactured for a
  request that did not happen.

### Negative / trade-offs

- **The endpoint is not covered by a USPTO SLA.** It is the backend the
  public search UI uses, but it may move or change without notice. The URL
  is configurable via `USPTO_SEARCH_URL` (default: the prod-stage path).
  `package.json` default and this ADR are updated at each release so
  operators can pin or override.
- **Best-effort top-N.** One query returns up to 100 hits ordered by
  relevance. A trademark match beyond position 100 is not seen. For common
  terms this is a known limitation, documented here; an exact-match second
  query is deferred to a follow-up ADR rather than enumerating the whole
  register (which would make every common term `unverified`).
- **No second independent source by default.** EUIPO is free but requires
  operator credentials (`EUIPO_CLIENT_ID`/`EUIPO_CLIENT_SECRET`) and, alone,
  cannot close `.com`/`.us` for a US-jurisdiction mark. The gate reports
  `partial: false` when EUIPO is simply unconfigured (ADR-0098 follows D7
  from ADR-0097's successor): `not configured` is not `failed`.

### Observability

- `wafBlockCount` / `wafBlockRate` are retained on `UsptoCasesProvider` but
  no longer incremented by browser-UA retries (the honest UA replaces the
  browser rotation). On the new path a WAF challenge is unexpected, not
  routine.
- The raw USPTO provider (`sources.rawUspto`) carries these counters for
  the metrics endpoint.
- `npm run check:trademarks` asserts `nike` → blocked and
  `vintagecoffee` → clear against the live registers, and fails the release
  workflow if the endpoint drifts.

### Open items

- A mirror endpoint per operator (`USPTO_SEARCH_URL=...`) is supported but
  not verified against any specific mirror.
- EUIPO credentials are optional; a second free source would improve
  confidence on non-`.com` TLDs and is tracked as post-launch work.

## Verification

- `npm run check:trademarks` — live canary, not in the offline gate
  (network-dependent).
- Unit fixtures for both the current `source` shape and the legacy
  `_source` shape in `src/providers/trademark/__tests__/trademark-providers.test.ts`,
  including "hits present but no readable field → throw" (schema drift).
- `npm run gate` (offline) continues to pass: no source → unverified,
  never clear.
