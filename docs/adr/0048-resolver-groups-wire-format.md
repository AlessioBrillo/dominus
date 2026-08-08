# ADR-0048: Custom Resolver Groups Accept the DoH Wire Format (ADR-0047 Gap)

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0040, ADR-0045, ADR-0046, ADR-0047 |
| **Project** | DOMINUS |

## Context

ADR-0047 shipped `DnsLookupSpec.format?: 'json' | 'wire'` for the **default**
DoH group: Google maps to its JSON API on `/resolve` and Quad9 is marked
`format: 'wire'` so the RFC 8484 wire leg is used. The runtime honours the
field in `node-dns-provider.ts` (`spec.format ?? 'json'`), and
`strategyToResolverGroups` populates it for every built-in strategy.

However, the **configuration schema rejected the field**: the `DNS_RESOLVER_
GROUPS` Zod schema describes each lookup as `{ type: 'doh', endpoint }`
without `format`, and Zod strips unknown keys by default. Consequences for
operators who override the resolver groups via `DNS_RESOLVER_GROUPS`:

1. A custom wire-only endpoint (e.g. `dns.quad9.net/dns-query`) could not
   express its format: the JSON leg was always used, the server answers
   505, the leg votes neutrally — the same silently-inert-leg failure mode
   ADR-0047 fixed for the defaults, now reachable through configuration.
2. A typo such as `format: "spdy"` was silently stripped instead of
   rejected, so a misconfiguration produced a degraded (inert) leg rather
   than a startup error.
3. Documentation drift: the parking-IP doc string promised a built-in
   default list that the implementation never applied (absent
   `DNS_PARKING_IPS_PATH` disables parking detection), `.env.example`
   suggested `DNS_TERTIARY_STRATEGY=dot-only` which duplicates the
   consensus secondary's default transport and gets dropped by the
   disjointness check (ADR-0045), and the compose recursor comment still
   referenced "candidate ADR-0047" although ADR-0047 had been accepted.

This ADR closes the gap: the wire format must be configurable per lookup,
drift between the schema and its documentation must be removed, and the
local probe validation (`validateResolverGroups`) must be covered by tests.

## Decision

1. **`DNS_RESOLVER_GROUPS` accepts `format` on DoH lookups** — the Zod
   schema's `doh` variant becomes
   `z.object({ type: z.literal('doh'), endpoint: z.string().url(), format: z.enum(['json', 'wire']).optional() })`
   with docs. `json` stays the default (unchanged behaviour); `wire` selects
   the RFC 8484 base64url leg so custom wire-only endpoints (Quad9, AdGuard,
   Mullvad) behave exactly like the built-in Quad9 leg from ADR-0047. A
   value outside the enum is now a **config error at load time**, not a
   silently stripped field.
2. **The wire leg is propagated end to end** — a custom resolver group read
   from config with `format: 'wire'` issues `GET /dns-query?dns=<base64url>`
   with no `name=` parameter, verified by provider-level tests; the runtime
   path already honoured `spec.format`.
3. **Config-surface docs align with behaviour** (best-effort, no
   behavioural change):
   - `DNS_PARKING_IPS_PATH` doc no longer promises a built-in default list
     (there is none; absence disables parking detection).
   - `.env.example` `DNS_TERTIARY_STRATEGY` example changed from
     `dot-only` (duplicates the consensus secondary default) to `native`
     with a comment explaining the trap.
   - `docker-compose.dns-consensus.yml` recursor comment drops the
     "candidate ADR-0047" back-reference; multi-arch tracking stays under
     ADR-0046.
   - The unused `getDefaultDohProviders`/`getDefaultDotProviders` exports
     are removed (no callers; the constants remain internal).
4. **`validateResolverGroups` matches decisions:** happy-path probe status,
   unexpected status, network failure, and the 5 s abort timeout are each
   covered by unit tests with a fake provider.

## Alternatives Considered

- **Reject unknown fields entirely in the schema** (`.strict()`). Rejected:
  would break other reserved fields and fails to be backwards-compatible
  with forward-looking configs.
- **Force wire by endpoint heuristic** (e.g. always wire for non-Google
  hosts). Rejected: brittle, undocumented, and silently changes behaviour
  of deployers who pinned a JSON-serving endpoint.
- **Keep the docs/example inconsistencies**: Rejected: `.env.example`
  `dot-only` duplicating the secondary would make the tertiary leg fail the
  disjointness gate needlessly — a documented trap that costs users the
  third opinion ADR-0045 added.

## Consequences

- **Positive** — resolver overrides are the full first-class surface
  ADR-0047 gave them: an operator can run a Quad9-only group correctly,
  typos surface as errors instead of silent inert legs, and docs no longer
  send users to the tertiary trap. Coverage for the startup probe grows.
- **Negative** — schema accepts `'json' | 'wire'` only; any third DoH
  format (there is none in use) needs a future ADR. Removing the two
  exports is an API change for any external consumer of the barrel file
  (none in-repo); semver practice tracked in the changelog.

## Verification

- Reproducer committed before this ADR (`test: add reproducer for format
  stripping in DNS_RESOLVER_GROUPS`): runs with `format: 'wire'` and
  asserts the field survives `loadConfig()` (previously stripped).
- `npx vitest run src/config.test.ts src/providers/dns` — 30 + 63 + 15
  tests green.
- Full backend suite — 2049 tests green (2037 + 30 − shifts); `npx tsc
  --noEmit`, `npx eslint` on the touched providers, Prettier clean.