# ADR-0063: DNS Consensus Independence — topology-aware disjointness

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-20 |
| **Authors** | Alessio Brillo |
| **Deciders** | Alessio Brillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0039, ADR-0040, ADR-0042, ADR-0045, ADR-0059 |
| **Project** | DOMINUS |

## Context

The 2-of-3 DNS consensus gate (ADR-0002) cross-validates every Available
verdict against a resolver strategy disjoint from the primary. Disjointness
was enforced at startup by comparing string endpoint keys
(`doh:<host>`, `dot:<host-or-ip>`, `native:<ip>`) between the primary's
resolver set and the consensus secondary's. Three gaps made the gate
weaker than its documentation claimed:

1. **Same operator, different transport (P1).** `doh:cloudflare-dns.com` and
   `dot:1.1.1.1` share no string endpoint, yet are the same anycast operator
   over two transports. A Cloudflare incident (BGP hijack, anycast outage,
   IXP fault) takes both legs down together — the second opinion was a
   rubber stamp, not an independent check. The default pairing
   (`doh-primary` primary + `dot-only` consensus) was exactly this case:
   the same three operators (Cloudflare, Google, Quad9) behind two
   transports.

2. **Same anycast IP, different transport (P1).** A DoH hostname resolving
   to the same IP a DoT leg addresses directly is invisible to a string
   comparison, even though the two legs hit the same anycast node.

3. **Shared emergency fallback vetoed the gate at runtime (P0).** The
   documented prod topology (docker-compose `dns-consensus.yml`) pins the
   primary's native fallback leg and the consensus secondary to the same
   private recursor (`172.20.0.10:5300`). The fallback is an emergency net,
   not the primary's main opinion, but the string-level check counted it:
   the gate was vetoed at boot, 2-of-3 consensus silently disabled, and
   `provider-status` still reported it as active. CI only asserted the
   compose env statically, never booted the gate.

Two further weaknesses surfaced while auditing the gate: the consensus
secondary and tertiary kept the in-memory LRU cache, and the gate called
`checkAvailability` without `forceRecheck`, so a verification could confirm
an Available verdict against a ≤5-minute-old snapshot instead of the live
resolver (P2); and a dead tertiary leg was only felt under
`requiredAvailable=2`, with no startup probe (P3).

## Decision Drivers

1. **Conservatism (ADR-0002)** — an Available verdict is the risky verdict;
   the gate must eliminate single-resolver opinions, and every hardening
   must make false Available strictly harder, never easier.
2. **Default installs must not silently lose the gate** — a fix that vetoes
   the default pairing would disable consensus for every operator who never
   touched DNS env vars, which is worse than the rubber stamp it replaces.
3. **Fail-open on boot-time transients** — the gate must never be disabled
   by a slow DNS resolution during startup; a transient failure to prove
   independence must not disable consensus.
4. **Operational honesty** — the reported provider status must reflect the
   gate that actually runs, not the gate that was intended.
5. **Zero-cost community edition** — no paid APIs; the independent opinions
   must come from public resolvers reachable without a subscription.

## Considered Options

### Option A: Resolve DoH hostnames to IPs and compare `ip:` keys across transports

At boot, resolve every DoH hostname in both resolver sets (A + AAAA, with a
short budget) and add `ip:<address>` keys to the endpoint comparison. A DoT
leg on `1.1.1.1` and a DoH leg on `cloudflare-dns.com` collide on
`ip:1.1.1.1`. Combined with a map of well-known resolver operators
(Cloudflare, Google, Quad9, AdGuard, Mullvad, NextDNS), same-operator
overlap is vetoed regardless of the IPs involved.

**Advantages:**
- Catches the same operator and the same anycast node behind two transports
- No config surface change; works for any strategy combination
- The operator map is a constant lookup, zero runtime cost

**Disadvantages:**
- Boot-time DNS resolution adds startup latency and a new failure mode
- Unknown operators are invisible to the operator map (IP overlap still caught)
- Vetoing any same-operator overlap kills the default `doh-primary` +
  `dot-only` pairing — the default gate would self-disable

**Cost Implications:** ~150 lines in the validator plus tests; 2 s resolution
budget per hostname at boot.

**Risk Assessment:** Resolution failures must fail open (recorded, never
fatal). Operator hints drift as resolvers change; the map is small and
reviewed.

---

### Option B: Operator-disjoint default consensus strategy (`dot-alternate`)

Keep the strict any-overlap operator veto from Option A, and change the
default `DNS_CONSENSUS_STRATEGY` from `dot-only` to a new `dot-alternate`
strategy that consults only operators the default primary never uses
(AdGuard, Mullvad, NextDNS over DoT). Operators who explicitly configure a
same-operator pairing get a loud startup veto with an explanatory log.

**Advantages:**
- The default gate is genuinely operator-disjoint and stays on
- Deliberate rubber-stamp configs are vetoed loudly instead of accepted
- The default consensus adds two operators the primary never consults,
  strictly increasing verdict diversity

**Disadvantages:**
- Default consensus strategy value changes (behavior change for installs
  relying on the `dot-only` default)
- The new strategy needs config enum, `strategyToResolverGroups`, and
  `.env.example` updates

**Cost Implications:** One strategy case, one enum entry, doc updates.

**Risk Assessment:** Existing installs that explicitly set
`DNS_CONSENSUS_STRATEGY=dot-only` now get the veto log and must switch —
the correct loud behavior for a config that was a rubber stamp.

---

### Option C: Containment rule only (veto when consensus adds no new operator)

Veto only when the consensus operator set is a subset of the primary's
(no new operator consulted), and extend the default DoT pool with
AdGuard/Mullvad so the default consensus adds new operators.

**Advantages:**
- Default strategy value unchanged
- Smaller diff

**Disadvantages:**
- The default pairing still rides the same three operators over two
  transports — precisely the correlated-failure case the gate exists to
  eliminate; the rubber stamp remains, just partially diluted
- Weaker semantics: "partially independent" is a judgment call that
  operators cannot audit

**Cost Implications:** Smallest of the three.

**Risk Assessment:** Undermines the user-visible guarantee; the default
consensus verdict can still be controlled by a single operator outage in
the worst case (3 of 5 legs shared).

## Decision

**Chosen option: Option A + Option B** — topology-aware disjointness
(resolved IPs + operator map, fail-open on resolution) enforced with a
strict any-overlap operator veto, plus a new operator-disjoint default
consensus strategy so the default gate stays on and is genuinely more
independent than before.

Option A provides the detection mechanism: resolve DoH hostnames at boot
(2 s budget, injectable for tests), compare `ip:` keys across transports,
and map well-known operators. A same-operator overlap on either side vetoes
the gate with the overlap details in the log. Resolution failures fail open
— the check runs on hostname-level keys and operator hints alone and records
`resolutionPartial`, because a slow boot must never disable the gate (that
would be the P0 failure this ADR exists to prevent).

Option B fixes what Option A would otherwise break: the default
`doh-primary` + `dot-only` pairing shares all three operators, so a strict
veto would disable consensus on every default install. The new
`dot-alternate` strategy (AdGuard 94.140.14.14, Mullvad 194.242.2.2,
NextDNS 45.90.28.2 over DoT) is operator-disjoint from the default primary,
so the default gate passes the strict check and gains two operators the
primary never consults. Explicit same-operator configs are now vetoed
loudly at startup with a log explaining how to fix them (pin an independent
recursor or switch strategies).

Option C was rejected: its containment rule still allows the default
pairing to ride the same three operators, which is the exact correlated
failure the gate exists to eliminate, and "partially independent" is a
semantics operators cannot audit. The strict rule with a disjoint default
is both simpler to reason about and strictly more conservative.

The P0 fallback bug is fixed by excluding emergency fallback legs from the
disjointness comparison entirely (the gate must be independent of the
primary's *main* opinion, not its last-resort net — a shared fallback can
never manufacture an Available verdict because a failed fallback returns
undefined, which can never outvote the other legs). The P2 staleness gap is
closed by giving the consensus legs `maxSize: 0` caches and passing
`forceRecheck: true` on every verification query. The P3 gap is closed by
probing the tertiary leg at startup alongside the secondary.

## Consequences

### Positive
- The default 2-of-3 gate is now genuinely operator-disjoint (3 + 3
  operators) and stays enabled out of the box
- Same-operator and same-anycast-IP pairings are detected and vetoed with
  actionable logs, instead of being accepted as "independent"
- The consensus always queries live resolvers; a ≤5-minute-old snapshot can
  no longer confirm an Available verdict
- `provider-status` reports the gate that actually runs (C2), and dead
  consensus legs are surfaced at boot (C5)
- The turnkey compose override (shared private recursor fallback) keeps the
  gate enabled (C1)

### Negative
- Installations that relied on the `dot-only` default consensus must pick a
  disjoint strategy or pin a private recursor; the startup veto log tells
  them how
- Boot now resolves up to a handful of DoH hostnames (2 s budget each,
  fail-open) before the gate is decided
- The operator map is static: a new public resolver is invisible until its
  operator is added to the map (IP-level overlap still catches it)

### Compliance and Security Implications
- The gate's verdict path no longer shares a correlated failure domain with
  the primary's main opinion; single-operator outages cannot manufacture an
  Available verdict through the default topology
- Boot-time resolution queries are plain DNS A/AAAA lookups to the system
  resolver — no new data leaves the host beyond standard resolution

### Migration and Monitoring Plan
- Default config change ships in v1.1.0: `DNS_CONSENSUS_STRATEGY` defaults
  to `dot-alternate`; `.env.example` documents the disjointness rule and
  the fallback-sharing semantics
- Logs to watch: the veto message (`consensus leg disabled — its resolver
  set is not an independent opinion`) and the partial-resolution warning;
  both surface misconfigurations at boot
- `dominus providers` / `/api/v1/providers` now show the actual gate state;
  operators with the compose override should see `2-of-3 consensus gate
  active`
- Rollback: `DNS_CONSENSUS_STRATEGY=dot-only` plus a pin of
  `DNS_CONSENSUS_NAMESERVERS` restores the previous topology (with a veto
  log if the primary shares operators)

### Validation
- Regression tests: the P0 compose override boots the gate (boot-equivalent
  test in `consensus-wiring.test.ts`); the P1 default pairing is vetoed
  while the new default is active; same-anycast-IP and operator-overlap
  cases are unit-tested with an injected resolver; the consensus stage
  asserts `forceRecheck` on both legs
- Success criteria: default installs run with the gate active and a
  strictly more diverse resolver set; rubber-stamp configs fail loudly at
  boot; no Available verdict can be confirmed from cache

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*