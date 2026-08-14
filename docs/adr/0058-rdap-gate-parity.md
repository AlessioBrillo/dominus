# ADR-0058: RDAP Gate Parity — Consensus Default-On, Resilient Bootstrap, Origin-Overlap Guard

## Metadata

| Field          | Value                          |
| -------------- | ------------------------------ |
| **Status**     | Accepted                       |
| **Date**       | 2026-08-14                     |
| **Authors**    | AlessioBrillo                  |
| **Deciders**   | AlessioBrillo                  |
| **Supersedes** | N/A                            |
| **Relates to** | ADR-0035, ADR-0049, ADR-0050, ADR-0051, ADR-0052 |
| **Project**    | DOMINUS                        |

## Context

ADR-0050 introduced the RDAP 2-of-2 consensus gate as **opt-in**: a second
HTTP query per Available verdict doubles RDAP volume, so the gate shipped off
by default. The result is a posture mismatch with the DNS side: DNS
consensus (ADR-0039) is on by default and fail-closed, while the RDAP gate —
the last availability filter before scoring — requires an operator to know
about and enable it. A misconfigured or default deployment therefore trusts a
single RDAP opinion, and a misbehaving authoritative server can pass wrong
verdicts straight into scoring.

The IANA bootstrap (ADR-0035) also lacks operational hardening. The bootstrap
fetch runs on a raw `fetch` with no retry, no backoff, and no shared
transport, and failures are invisible: nothing exposes whether the server map
is stale or how long it has been. The stage already carries a *static*
disjointness validator (`validateRdapConsensusOriginDisjointness`) that
rejects configurations where the second leg is authoritative for the primary
bootstrap's TLDs, but there is no runtime equivalent: with a default
`rdap.org` second leg, the static validator cannot fire, and per-TLD cases
(say `rdap.verisign.com` as second leg, which is authoritative for `.com`)
would produce a rubber-stamp consensus — the same provider confirming its own
verdict.

Finally, the WHOIS rescue leg (ADR-0051) and the general WHOIS provider can
hold sockets for the full timeout after the caller aborts a run: the abort
signal is accepted but ignored mid-flight, and every aborted query is counted
as a server failure by the circuit breaker, degrading future lookups for
caller-initiated cancellations.

## Decision Drivers

1. **Parity with DNS consensus** — DNS 2-of-3 is default-on and fail-closed;
   the RDAP gate must behave the same so a default deployment gets the same
   protection.
2. **Zero-config correctness** — the default second leg must be a
   well-known, independent origin (`rdap.org`), and the gate must stay sound
   even when that origin is authoritative for a candidate's TLD.
3. **Operational observability** — bootstrap health and consensus tallies
   must be visible in the existing Prometheus surface at zero new cost.
4. **No spurious circuit breaking** — caller-initiated aborts are not server
   failures; they must not trip the WHOIS breaker or trigger TLS fallbacks.

## Considered Options

### Option A: Default-on gate with rdap.org, runtime overlap guard, resilient bootstrap (chosen)

Enable the gate by default (`RDAP_CONSENSUS_ENABLED=true`) with
`https://rdap.org/` as the default second leg. Add a runtime per-TLD guard:
before verifying a candidate, the stage resolves the candidate TLD's
authoritative origins from the same bootstrap and skips the second leg
(tallying `originOverlap`) when the second leg's origin is authoritative for
that TLD. Harden the bootstrap with exponential backoff (base 5 min, max
24 h), status listeners, and the shared undici agent pool (ADR-0049). Expose
consensus + bootstrap series in `/metrics`. Teach the WHOIS provider to
destroy the socket and reject with `AbortError` on caller abort without
counting it as a failure.

**Advantages:**
- Default deployments get the same fail-closed protection as DNS.
- The overlap guard keeps the 2-of-2 sound for every TLD without operator
  configuration.
- Bootstrap health and gate tallies become observable at zero cost.
- Aborts are treated as cancellations, not failures — the breaker and TLS
  fallback stay accurate.

**Disadvantages:**
- RDAP query volume doubles on every default deployment (the known cost of
  consensus, already accepted in ADR-0050).
- `rdap.org` is a third-party routing service: an outage degrades the gate
  to unverifiable (fail-closed) until it recovers.
- The overlap guard slightly widens the unverifiable bucket for TLDs owned
  by the second leg (e.g. `.com` under a Verisign second leg).

**Cost Implications:** No new infrastructure or paid APIs. One extra HTTP
query per Available verdict (existing consensus budget covers it, ADR-0050).
Development effort: 4 focused changesets (config, bootstrap, stage guard,
metrics/abort).

**Risk Assessment:** Low. The gate remains fail-closed in every path; the
overlap guard only ever *skips* a redundant confirmation, never an
independent one. Rollback is a single env flip.

---

### Option B: Keep the gate opt-in, only fix the bootstrap

Leave `RDAP_CONSENSUS_ENABLED=false` as the default and ship only the
bootstrap backoff + metrics + abort fixes.

**Advantages:**
- Zero behaviour change for existing deployments; no volume increase.
- Smaller diff, no new guard logic.

**Disadvantages:**
- Default deployments stay single-opinion on RDAP while DNS is protected —
  the parity gap that motivated this ADR remains.
- Requires every operator to discover and enable the gate (the current
  discovery problem).

**Cost Implications:** Lowest development effort. No operational cost change.

**Risk Assessment:** Low technical risk, but the product risk that motivated
the decision is unaddressed.

---

### Option C: Gate default-on without a runtime overlap guard

Enable the gate by default with `rdap.org`, but rely only on the existing
static disjointness validator.

**Advantages:**
- Smallest diff toward parity.
- The static validator already catches full-overlap configurations.

**Disadvantages:**
- The default config (rdap.org second leg) is precisely the case the static
  validator cannot catch: rdap.org is authoritative for a growing set of
  TLDs, so those candidates get a self-confirming second opinion.
- An operator switching to a scoped second leg (e.g. Verisign) silently
  creates rubber-stamp consensus for that leg's TLDs.

**Cost Implications:** Slightly lower than Option A (no stage changes).

**Risk Assessment:** Medium — correctness gap on per-TLD overlap that is
invisible without the runtime guard.

---

## Decision

**Chosen option: Option A.**

The decision is parity, not volume: a domain investment tool whose DNS layer
refuses to trust a single resolver must not trust a single RDAP server on the
last availability gate before scoring. Defaulting the gate on with a
well-known independent second leg (`rdap.org`) gives every deployment the
same posture with zero configuration, exactly as DNS consensus does.

The runtime overlap guard resolves the one correctness hole a default-on gate
opens: rdap.org (and any registry-scoped leg) is authoritative for some TLDs,
and for those candidates the 2-of-2 would be a rubber stamp. Resolving the
candidate TLD's authoritative origins from the same IANA bootstrap used by
the primary path, and skipping the second leg when its origin is among them,
keeps the gate honest for every TLD without operator input. This is strictly
better than Option C, which only catches whole-configuration overlap, and it
reuses the ADR-0035 bootstrap resolution that already exists.

The bootstrap hardening (Option A) is shared by the primary path and the
guard: exponential backoff with a 24 h cap, last-known-good service during
backoff, status listeners feeding `dominus_rdap_bootstrap_*` series, and
transport through the shared undici agent pool (ADR-0049) so the bootstrap
respects `RDAP_MAX_CONNECTIONS`. The abort fix closes the WHOIS-loop
interaction (ADR-0051, ADR-0052): a caller abort now destroys the socket,
rejects with `AbortError`, and skips both the TLS fallback and the circuit
breaker penalty — aborts are cancellations, not failures.

## Consequences

### Positive
- Default deployments are fail-closed on RDAP, matching the DNS posture
  (ADR-0039).
- The gate is provably sound per TLD, not just per configuration.
- Bootstrap health, consensus verdicts, overlap skips, and WHOIS rescues are
  all observable in Prometheus (`dominus_rdap_consensus_*`,
  `dominus_rdap_bootstrap_*`).
- Cancelled runs no longer poison the WHOIS circuit breaker or burn TLS
  fallback budget.

### Negative
- RDAP egress roughly doubles on default deployments (accepted in ADR-0050).
- An rdap.org outage makes every Available verdict unverifiable
  (fail-closed) until the bootstrap backoff window or the service recovers.
- `.env.example` and startup logs must clearly explain the new defaults;
  operators who explicitly disabled the gate must keep `false` in their env
  (uncommented values win).

### Compliance and Security Implications
- Fail-closed behaviour is preserved in every path; no verdict is ever
  confirmed by a leg that is authoritative for the candidate's TLD.
- No new secrets, keys, or endpoints are introduced; rdap.org is a public,
  keyless endpoint already in use by the primary failover.
- The overlap guard reads the same public bootstrap registry; no
  privacy-sensitive data leaves the process beyond the domain query itself.

### Migration and Monitoring Plan
- Migration is configuration-only: `RDAP_CONSENSUS_ENABLED` now defaults to
  `true` and `RDAP_CONSENSUS_ENDPOINT` to `https://rdap.org/`. Existing
  deployments that explicitly set either variable are unaffected (explicit
  values win). An empty explicit endpoint still disables the gate with the
  existing prominent warning.
- The bootstrap starts `warm()` at boot and backfills through the same
  backoff path; the previously synchronous startup fetch becomes the first
  warm-up fetch.
- Watch `dominus_rdap_bootstrap_ok` (gauge), `_failures_total` (counter) and
  `dominus_rdap_consensus_*` after the rollout; alert on sustained
  `consecutiveFailures` growth, which indicates the registry or the pool is
  unreachable.
- Rollback: set `RDAP_CONSENSUS_ENABLED=false` — a single env flip restores
  the pre-ADR behaviour; no schema or data changes exist to revert.

### Validation
- Unit/integration coverage on the config defaults, bootstrap backoff +
  status listeners + pooled transport, per-TLD overlap guard (skips, cache,
  resolver failure tolerance), WHOIS abort semantics (3 aborts + 1 success
  leaves the breaker closed), and the new Prometheus series.
- Pre-push quality gate (typecheck, build, lint, format, tests) and the
  repository pre-commit hooks are green on the feature branch before merge.
- Post-merge smoke: run a pipeline with the defaults on, confirm
  `dominus_rdap_consensus_verified_total` increments and
  `dominus_rdap_bootstrap_ok` is 1.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*