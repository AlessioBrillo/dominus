# ADR-0047: Live-Verified DoH Legs — Provider Endpoints and RFC 8484 Wire

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0040, ADR-0044, ADR-0045 |
| **Project** | DOMINUS |

## Context

The default DoH group (`multi-doh`) is built from a static list of three
providers — Cloudflare, Google, Quad9 — and every `DNS_LOOKUP_STRATEGY`
variant derives its `multi-doh` lookups from that list. The DNS consensus
gate (ADR-0040, ADR-0045) requires a **strict majority of the group** for
an Available verdict, and a single definitive resolve alone decides
Registered. The conservatism of the whole gate therefore rests on the
premise that every configured leg can actually answer a query.

A live probe of the three endpoints (reproduced in the RED commit
7052d21) showed that premise to be false:

1. **Google** — `https://dns.google/dns-query` answers `400` to JSON GETs.
   The JSON API lives on `/resolve` and additionally requires the
   `ct=application/dns-json` query parameter. The configured endpoint was
   perpetually inert.
2. **Quad9** — `dns.quad9.net/dns-query` is **RFC 8484 wire-format only**:
   it answers errors to `application/dns-json` JSON GETs. There is no JSON
   API at all.
3. **Cloudflare** — answers JSON on `/dns-query`; the only leg that
   worked.

The practical consequence: a "2-of-3" Available verdict was in reality
decided by a single live transport (Cloudflare). A lone external opinion
was passing the majority gate, which is exactly the single-opinion
availability risk ADR-0040 was written to eliminate, and which the
scoring engine's conservatism principle (ADR-0002) forbids for the risky
(available) verdict.

## Decision

Every default DoH lookup now ships the **request format its endpoint
actually speaks**, and each provider's endpoint is corrected to its
live-verified path:

1. **Google** → `https://dns.google/resolve`; `resolveDoh` (JSON leg)
   unconditionally sets `ct=application/dns-json` (Google requires it,
   Cloudflare ignores it) so the parameter is safe on all JSON legs.
2. **Quad9** → stays on `/dns-query` but its spec is marked
   `format: 'wire'`; a new **RFC 8484 wire leg** (`GET ?dns=<base64url>`)
   is used for wire-only endpoints. The wire leg reuses the DoT pool's
   `buildDnsQuery` (A/NS/SOA/… qtype mapping via `recordTypeToQtype`),
   verifies the DNS ID with `validateDnsResponse`, and shares
   `classifyResponse` — the same conservative RCODE semantics as DoT:
   NXDOMAIN and NODATA are definitive, SERVFAIL/REFUSED/truncated are
   neutral errors, a mismatched query ID is dropped as corrupt (ADR-0002).
3. `DnsLookupSpec.format?: 'json' | 'wire'` flows from
   `strategyToResolverGroups` (all DoH strategies) through `resolvesAnyDoh`
   into the leg selection; `getDefaultDohProviders()` exposes the format
   for status surfaces.

Verdict semantics on the JSON leg are unchanged (Status 0 + Answer =
registered; Status 3 = NXDOMAIN; any other RCODE = neutral ESERVFAIL).

## Alternatives Considered

- **Set Google to wire format instead.** Rejected: Google's wire endpoint
  is not usable as a default edge for identical reasons (it requires
  `/resolve` semantics distinctions); JSON is the primary, documented
  Google transport.
- **Drop Google or Quad9 from the default group.** Rejected: reduces
  transport diversity for a fixable endpoint issue; both providers are
  free, keyless, and well-connected.
- **Treat any single NXDOMAIN from any leg as Available.** Rejected:
  that is precisely the single-opinion risk the majority gate exists to
  prevent (ADR-0040).
- **Route Quad9 wire requests through the DoT pool chained on the same
  endpoint.** Rejected: DoH is its own transport with its own timeout
  budget and answer; chaining doubles latency and couples two legs.

## Consequences

- **Positive**: a majority Available verdict now requires three live
  transports, one lone NXDOMAIN can no longer pass as a consensus, and
  provider status surfaces report the real per-endpoint formats. The
  fix is rolling config: existing deployments gain correctness on
  restart with no schema, CLI, or env changes.
- **Negative**: the DoH layer now has two request shapes (JSON + wire)
  to maintain, and wire responses require buffer/RCODE parsing instead
  of `response.json()`. Both transports are free, keyless public
  endpoints — the zero-cost constraint (ADR-0001) holds.

## Verification

- The reproducer committed with 7052d21 sends real JSON GETs to all three
  endpoints with `accept: application/dns-json` and captured the 400 /
  505 / 200 split that motivated this ADR.
- `npx vitest run src/providers/dns` — 114 tests green.
- Full backend suite — 2037 tests green.
- `npx tsc --noEmit`, `npx eslint` on the touched providers, Prettier
  clean at 100 print width.