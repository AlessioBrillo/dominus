# ADR-0059: DNS Consensus Strictness and Per-Endpoint Circuit Breakers

## Metadata

| Field          | Value                          |
| -------------- | ------------------------------ |
| **Status**     | Accepted                       |
| **Date**       | 2026-08-16                     |
| **Authors**    | AlessioBrillo                  |
| **Deciders**   | AlessioBrillo                  |
| **Supersedes** | N/A                            |
| **Relates to** | ADR-0002, ADR-0039, ADR-0040, ADR-0044, ADR-0045, ADR-0047, ADR-0048, ADR-0051 |
| **Project**    | DOMINUS                        |

## Context

The DNS 2-of-3 consensus gate (ADRs 0039, 0040, 0045) is fail-closed: an
Available verdict needs confirmation from a second, resolver-disjoint leg.
Four hardening gaps remain:

1. **Strictness drift on `DNS_CONSENSUS_REQUIRED_AVAILABLE=2`.** The
   documented semantics (src/config.ts) say 2 = "BOTH the secondary and the
   tertiary must confirm the primary's Available". The implementation,
   however, still treats the tertiary as a *rescue* leg: when the secondary
   fails, a tertiary-only Available passes the gate. Under the strict
   configuration this is a single independent confirmation dressed as two —
   exactly the false-confidence the gate exists to prevent. The default (1)
   is unaffected.
2. **No circuit breaker on the DNS layer.** RDAP and WHOIS have two-level
   circuit breakers (global + per-server, ADR-0051); DNS has only
   per-connection strike accounting inside each DoT pool. A persistently
   failing resolver (egress port 853 filtered, DoH endpoint down, private
   recursor wedged) burns the full lookup timeout on every query, every run,
   for the whole window — and pollutes the availability majority with
   undecided legs.
3. **Parking-IP detection is a silent no-op by default.** `ParkingIpRegistry`
   is only populated when `DNS_PARKING_IPS_PATH` points at a file; with no
   file the check (when enabled) can never fire. There is no bundled
   reference list, so the feature's default behaviour is "off" without saying
   so.
4. **Watchlist DNS verdicts are single-provider by design.** The watchlist
   polls through the primary provider only, with an RDAP confirmation as the
   second opinion. The RDAP leg (authoritative, ADR-0035) is the actual
   safety net, but the design is invisible: a reader of the logs cannot tell
   that an Available was not consensus-verified.

Also surfaced: two dead config keys (`SCORING_CONFIDENCE_THRESHOLD`,
`SCORING_RECOMMEND_THRESHOLD`) that the scoring engine no longer reads, and
doc drift in ADR-0002 (500 EUR cap / 0.3 threshold) versus the
evidence-anchored value design (ADR-0055). These are cleaned up as
documentation/config hygiene in the same changeset.

## Decision Drivers

1. **Strict configuration must be strict** — when the operator pins
   `DNS_CONSENSUS_REQUIRED_AVAILABLE=2`, a tertiary-only Available is an
   unverifiable verdict, not a rescued one. The default (1) keeps today's
   rescue semantics.
2. **Fail-safe breaker bookkeeping** — the breaker is a resilience
   optimization, not a safety gate: the fail-closed Unknown path is the
   safety. Breaker bookkeeping failures (Redis down, registry misconfig)
   must never take DNS down; they degrade to "allow".
3. **Zero-config correctness** — parking detection must work out of the box
   with the bundled reference list, matching the provider-abstraction and
   cost-discipline principles (ADR-0001, ADR-0004).
4. **Observability at zero new cost** — breaker state joins the existing
   Prometheus surface (`dominus_dns_breaker_*`).
5. **Cancellation discipline (ADR-0058)** — caller-initiated aborts are not
   server failures and must not trip the breaker.

## Considered Options

### Option A: Strict requiredAvailable=2 + per-endpoint breaker registry + bundled parking list (chosen)

**Strictness:** in the consensus gate, when `requiredAvailable >= 2` and the
secondary failed, a tertiary Available no longer passes the candidate: the
verdict is Unknown (unverifiable), counted in `unverifiable`. The tertiary is
still consulted so a tertiary *Registered* keeps its veto power — the rescue
leg is never a rubber stamp, and the conservative direction stays intact.

**Breaker:** a new `DnsBreakerRegistry` in
`src/providers/dns/dns-breaker.ts` keyed per endpoint:
`doh:<host>`, `dot:<endpoint|servername|port>`, `native:<nameservers join>`,
`native:system-resolver`. It reuses the existing `CircuitBreaker` policy
(in-memory, default 5 failures / 60 s window / 120 s cooldown — mirroring the
RDAP per-server breaker) or `DistributedCircuitBreaker` when Redis is
available (ADR-0033), keyed `cb:dns:<endpoint>`. The primary, secondary, and
tertiary providers share one registry instance per run composition.

Inside `#raceGroup` a leg whose breaker is open is skipped (resolved as
`undefined` without a wire query) and the availability majority denominator
still counts it — a skipped leg never manufactures an Available. Breaker
outcomes are recorded only after the caller's abort signal is checked:
`callerAborted` is captured *before* the internal `childAbort` fires, so
run-cancellation aborts never trip the breaker (ADR-0058). A single
resolving leg still wins (conservative-safe, unchanged). All registry calls
are guarded: bookkeeping errors fail open.

New config, default-on with the same shape as the RDAP breaker:
`DNS_CIRCUIT_BREAKER_ENABLED=true`, `DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD=5`,
`DNS_CIRCUIT_BREAKER_WINDOW_MS=60000`, `DNS_CIRCUIT_BREAKER_COOLDOWN_MS=120000`.

**Parking:** `ParkingIpRegistry.load(path, fallbackPath)` falls back to a
bundled `src/providers/dns/parking-ips.json` reference list when
`DNS_PARKING_IPS_PATH` is unset or the file is missing. The check itself
stays opt-in (`DNS_PARKING_CHECK_ENABLED=false` default) — but enabling it
now does something without extra setup.

**Watchlist:** the single-provider DNS verdict is labelled in the job log
(warn-level on an Available path) and documented: the mandatory RDAP
confirmation is the authoritative second opinion (ADR-0035), so watchlist
notifications remain two-leg checked — DNS fast path + RDAP authority.

**Advantages:**

- Strict config becomes strictly fail-closed; the tertiary is demoted to
  what it is: a veto/confirmation leg, not a substitute second opinion.
- A dead resolver stops consuming wire timeouts after `failureThreshold`
  failures; consensus degrades fast and visibly instead of slowly and
  silently.
- Parking detection works with zero config; the bundled list is a
  conservative, community-maintainable reference.
- Breaker state is observable (`dominus_dns_breaker_*`) and aborts stay
  free of spurious trips.

**Disadvantages:**

- One extra config surface to document; risk of mis-tuning (mitigated by
  sane defaults mirroring the RDAP breaker and `ENABLED=false` escape hatch).
- The bundled parking list is a static snapshot; operators who want fresher
  data still point `DNS_PARKING_IPS_PATH` at their own file.
- Strict mode widens `unverifiable` when the secondary is down — that is
  the point, but it changes the degraded-run tally in strict deployments.

**Cost Implications:** zero infrastructure cost (community edition, ADR-0001).
No paid APIs. Development effort: 3 focused changesets (config + registry,
provider wiring, stage strictness + parking default + watchlist label).

**Risk Assessment:** Low. Every change preserves the fail-closed direction;
the breaker can only *skip* queries that would otherwise time out; the
strictness change only tightens a configuration whose documentation already
promises the tightened semantics.

---

### Option B: Only fix the strictness drift

Ship the `requiredAvailable=2` fix and the parking default; leave DNS
without a circuit breaker.

**Advantages:**

- Minimal diff; no new config surface.
- The strictness bug is the only one with an availability-verdict impact.

**Disadvantages:**

- The resilience gap (C2) stays: a dead resolver keeps consuming the full
  timeout budget on every query and pollutes the majority tally with
  undecided legs — the exact failure mode the RDAP/WHOIS layers already
  protect against.
- No observability for resolver health beyond per-query timeouts.

---

### Option C: Per-leg strike counting only (no registry, no config)

Reuse the DoT pool's per-connection strikes as a crude open/skip heuristic
with no shared registry and no metrics.

**Advantages:**

- No new files or config.

**Disadvantages:**

- Only covers DoT pools; DoH and native legs stay unprotected.
- No shared state between primary/secondary/tertiary (each builds its own
  pools); no observability; semantics undocumented.

---

## Decision

**Option A.** The strictness fix is mandatory (documented semantics vs.
implementation drift). The breaker registry closes the resilience parity gap
with RDAP/WHOIS at zero infra cost, and the bundled parking list removes a
silent no-op default. The watchlist label is documentation + a log line, not
a behavioural change — the RDAP leg is already the authoritative second
opinion there.

## Consequences

### Positive

- `DNS_CONSENSUS_REQUIRED_AVAILABLE=2` now means what the config
  documentation says: both secondary and tertiary must confirm. Tertiary-only
  rescues land in `unverifiable` and the run degrades visibly.
- DNS failures become circuit-aware: after `failureThreshold` consecutive
  failures an endpoint is skipped for `cooldownMs`, the availability
  majority stays honest, and `dominus_dns_breaker_*` exposes open/half-open
  state to Prometheus.
- Parking-IP detection works out of the box (bundled reference list) while
  staying opt-in.
- Cancellation discipline is preserved: caller aborts never trip breakers.
- Dead config keys removed; ADR-0002 doc drift corrected (references
  ADR-0055).

### Negative

- Strict deployments see wider `unverifiable` tallies during secondary
  outages — intended, but visible in dashboards.
- New config surface requires `.env.example` documentation.
- The bundled parking list needs periodic maintenance to stay current
  (documented in the file header).

## Verification

- Unit: `dns-breaker.test.ts` (registry, keys, open/skip/half-open recovery,
  fail-open on bookkeeping errors, abort non-trip), stage strictness tests
  (requiredAvailable=2 + tertiary-only rescue → Unknown; tertiary veto still
  blocks), factory tests (breaker wiring + Redis distributed mode), config
  defaults, parking default-list fallback.
- Integration: `ci:backend` full gate (typecheck, build, lint, format, tests
  with coverage thresholds 70/65/60).
- Operational: Prometheus shows `dominus_dns_breaker_open` after repeated
  resolver failure; strict deployment logs `unverifiable` instead of
  `tertiaryRescued` when the secondary is down.