---
title: DNS Community Edition Fallback — NodeDnsProvider for Zero-Dependency Onboarding
status: accepted
date: 2026-09-26
decision-makers: [Principal Software Engineer]
---

## Context

ADR-0075 completed ADR-0072 by making UnboundResolver the **exclusive** DNS provider with mandatory DNSSEC validation. This hardened architecture is correct for production (DOMINUS Cloud) but creates a significant barrier for community edition users:

| Barrier | Impact |
|---------|--------|
| Unbound installation required | Ubuntu/Debian: `apt-get install unbound`; Windows: no native package; macOS: `brew install unbound` |
| `unbound.conf` configuration | Must correctly set `validator: yes`, `val-permissive-mode: no`, `forward-tls-upstream: yes` |
| Port 53 exposure | UDP/TCP 53 must be reachable (container networking, host firewall, cloud security groups) |
| No graceful degradation | Any misconfiguration = hard boot failure |

Community edition users (self-hosted, single-user, often on Windows or shared hosting) cannot reasonably run Unbound. The "zero-dependency onboarding" promise from earlier ADRs was broken.

## Decision

**Restore `NodeDnsFallback` as a conditional fallback for community edition only:**

1. **`DNS_UNBOUND_STRICT` default becomes context-aware:**
   - **Cloud mode** (DATABASE_URL set OR AUTH_PROVIDER ≠ 'env'): `true` (hardened, mandatory Unbound)
   - **Community edition** (SQLite + AUTH_PROVIDER=env): `false` (allows NodeDnsFallback)

2. **Explicit env var always wins:** If `DNS_UNBOUND_STRICT=true/false` is explicitly set, that value is used regardless of mode.

3. **Fallback behavior (when `DNS_UNBOUND_STRICT=false`):**
   - Attempt Unbound health check first
   - If Unbound unhealthy OR DNSSEC validation not confirmed → log warning → fall back to `NodeDnsFallback`
   - `NodeDnsFallback` uses native Node.js DNS (DoH/DoT via system resolver) with `dnssec: 'unchecked'` stamp
   - Metrics emitted via `recordFallbackActive(true)` for observability

4. **New config property:** `IS_CLOUD_MODE` (computed) — `true` when DATABASE_URL or AUTH_PROVIDER ≠ 'env'

5. **Unbound config validation:** Added `validateUnboundConfig()` method that queries unbound-control interface to verify `validator: yes` and `val-permissive-mode: no` at startup. Fails fast in strict mode if validation fails.

## Configuration Changes

| Variable | Old Default | New Default (Community) | New Default (Cloud) |
|----------|-------------|------------------------|---------------------|
| `DNS_UNBOUND_STRICT` | `true` | `false` | `true` |

No new env vars required. Detection is automatic from existing `DATABASE_URL` and `AUTH_PROVIDER`.

## Migration Guide

### Community Edition (existing users upgrading)

**No action required.** The fallback activates automatically when:
- `DATABASE_URL` is not set (using SQLite)
- `AUTH_PROVIDER=env` (default)
- `DNS_UNBOUND_STRICT` is not explicitly set to `true`

```bash
# .env remains unchanged — fallback just works
# Optional: verify fallback is active in logs
# "Unbound health check failed — falling back to NodeDnsFallback (DNSSEC validation disabled)"
```

### Cloud Edition (production)

**No action required.** Strict mode remains default and enforced.

```bash
# Ensure these are set (already required by ADR-0075):
DATABASE_URL=postgresql://...
DNS_UNBOUND_HOSTS=unbound:5300
DNS_UNBOUND_STRICT=true  # explicit for clarity
DNS_UNBOUND_HEALTH_CHECK_ENABLED=true
```

### Operators wanting strict mode in community edition

```bash
# Explicitly opt-in to hardened architecture
DNS_UNBOUND_STRICT=true
DNS_UNBOUND_HOSTS=127.0.0.1
DNS_UNBOUND_HEALTH_CHECK_ENABLED=true
# Must run Unbound locally with correct config
```

## Consequences

### Positive

- **Community edition works out-of-the-box** — no Unbound installation/configuration required
- **Cloud edition unchanged** — hardened architecture preserved, DNSSEC validation mandatory
- **Explicit override respected** — operators can choose either mode in either edition
- **Observability** — `recordFallbackActive(true)` metric alerts operators when fallback is in use
- **Fail-fast config validation** — catches Unbound misconfigurations at startup in strict mode

### Negative

- **Community edition DNSSEC validation disabled in fallback** — Available verdicts stamped `dnssec: 'unchecked'`
- **Two code paths to maintain** — UnboundResolver (strict) and NodeDnsFallback (fallback)
- **Slightly larger attack surface** — fallback uses system resolver without DNSSEC proof

### Neutral

- **RDAP/WHOIS/Trademark stages unaffected** — they operate independently
- **Pipeline degradation flags work** — DNS stage reports `dns-unvalidated` degradations when fallback used
- **Per-query DNSSEC (ADR-0073) only runs in strict mode** — controlled by `DNS_PER_QUERY_DNSEC` which remains `true` by default

## Security Considerations

- Fallback mode **explicitly does not perform DNSSEC validation** — documented in `NodeDnsFallback` constructor warning
- Cloud deployments **must not** use fallback — enforced by `IS_CLOUD_MODE` detection
- Operators can detect fallback usage via:
  - Log: `"Unbound health check failed — falling back to NodeDnsFallback"`
  - Metric: `dominus_dns_fallback_active 1`
  - Health endpoint: `/api/v1/health` shows DNS provider name

## Related ADRs

- **ADR-0075** — UnboundResolver as Single Source of Truth (superseded for community edition)
- **ADR-0072** — Unbound Resolver as Single Source of Truth (original)
- **ADR-0073** — DNSSEC Per-Query Validation (strict mode only)
- **ADR-0061** — DNSSEC Fail-Closed (reinforced for strict mode)
- **ADR-0059** — DNS Circuit Breaker (simplified for single resolver)

## Rollback Plan

If issues arise with community fallback:

1. Set `DNS_UNBOUND_STRICT=true` explicitly in community `.env`
2. Install/configure Unbound locally per ADR-0075 migration guide
3. This restores ADR-0075 behavior completely — no code changes needed