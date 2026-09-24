---
title: DNS: UnboundResolver as Single Source of Truth (ADR-0072 Completion)
status: accepted
date: 2026-09-24
decision-makers: [Principal Software Engineer]
---

## Context

ADR-0072 established UnboundResolver as the single DNS source of truth, but the implementation retained a dual-resolver architecture:

1. **UnboundResolver** — Primary resolver with proven DNSSEC validation via negative-control probes
2. **NodeDnsProvider** — Fallback resolver (native node:dns, DoH, DoT) used when Unbound was unhealthy or DNSSEC validation was lost

This dual architecture created several critical issues:

| Issue | Impact |
|-------|--------|
| **Ambiguous DNSSEC semantics** | Same domain could receive `dnssec: 'valid'` from Unbound but `dnssec: 'unchecked'` from NodeDnsProvider fallback |
| **Cache incoherence** | Two independent cache layers (Unbound + NodeDnsProvider) with different TTLs and invalidation logic |
| **Breaker registry sharing** | Shared `DnsBreakerRegistry` but different failure semantics per resolver type |
| **Per-query DNSSEC opt-in** | `DNS_PER_QUERY_DNSSEC=false` default left a 10-minute window where `val-permissive-mode: yes` reconfiguration could go undetected |
| **Single positive control** | Health check relied solely on `sigok.verteiltesysteme.net` — zone outage = global resolver failure |

## Decision

Complete ADR-0072 by making **UnboundResolver the exclusive `DnsProvider` implementation**:

1. **Remove `NodeDnsProvider` from `buildDnsProvider`** — No fallback path; `DNS_UNBOUND_ENABLED=false` is no longer supported
2. **Enable per-query DNSSEC validation by default** (`DNS_PER_QUERY_DNSEC=true`) — Every Available verdict gets cryptographic proof (DS → DNSKEY → RRSIG) for that specific domain
3. **Distributed positive controls** (`DNSSEC_POSITIVE_CONTROLS`) — Multiple known-good DNSSEC zones (`sigok.verteiltesysteme.net`, `dnssec.works`, `test.dnssec-tools.org`) provide geographic/topological diversity
4. **Fail-fast on health check failure** — No silent fallback; operator must fix Unbound configuration
5. **Remove fallback-specific config** — `DNS_UNBOUND_FALLBACK_ENABLED`, `DNS_UNBOUND_FALLBACK_REVALIDATION_INTERVAL_MS`, `DNS_UNBOUND_MAX_UNHEALTHY_BEFORE_FALLBACK` replaced with `DNS_UNBOUND_MAX_UNHEALTHY_BEFORE_DEGRADED`

## Configuration Changes

### New Required Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DNS_UNBOUND_HOSTS` | `127.0.0.1` | Comma-separated Unbound host(s) — **required** |
| `DNS_PER_QUERY_DNSEC` | `true` | Enable per-query DNSSEC validation for Available verdicts |
| `DNS_PER_QUERY_DNSEC_TIMEOUT_MS` | `2000` | Timeout for per-query validation |
| `DNSSEC_POSITIVE_CONTROLS` | `sigok.verteiltesysteme.net,dnssec.works,test.dnssec-tools.org` | Comma-separated positive control domains |

### Removed Settings

| Variable | Replacement |
|----------|-------------|
| `DNS_UNBOUND_FALLBACK_ENABLED` | Removed — no fallback |
| `DNS_UNBOUND_FALLBACK_REVALIDATION_INTERVAL_MS` | Removed — no fallback |
| `DNS_UNBOUND_MAX_UNHEALTHY_BEFORE_FALLBACK` | → `DNS_UNBOUND_MAX_UNHEALTHY_BEFORE_DEGRADED` |

### Behavior Changes

| Scenario | Old Behavior | New Behavior |
|----------|--------------|--------------|
| Unbound unhealthy at boot | Fallback to NodeDnsProvider (warning) | **Boot fails** with actionable error |
| DNSSEC validation lost at runtime | Activate fallback (warning) | **Log error**, mark resolver degraded, continue serving with `dnssec: 'unchecked'` |
| Per-query DNSSEC timeout | N/A (disabled by default) | Returns `dnssec: 'valid'` from resolver-level stamp (fail-open for availability) |
| Positive control zone unreachable | Global resolver failure | Try next positive control; only fail if all exhausted |

## Consequences

### Positive

- **Single source of truth** for DNS — no ambiguity about which resolver answered
- **Cryptographic proof per Available verdict** — closes the `val-permissive-mode` window (ADR-0073)
- **Resilience through diversity** — multiple positive controls survive single-zone outages
- **Simpler architecture** — one resolver, one cache, one breaker registry, one code path
- **Fail-fast operational model** — operator alerted immediately on resolver issues

### Negative

- **Unbound becomes mandatory** — Community edition must run Unbound locally (Docker or host)
- **No graceful degradation** — Unbound misconfiguration = hard boot failure
- **Per-query DNSSEC latency** — ~50-200ms additional per Available domain (mitigated by resolver-level stamp fail-open)

## Migration Guide

### Community Edition (no Docker)

```bash
# Install Unbound locally
# Ubuntu/Debian:
sudo apt-get install unbound

# Configure /etc/unbound/unbound.conf:
#   server:
#     validator: yes
#     val-permissive-mode: no
#     forward-zone:
#       name: "."
#       forward-tls-upstream: yes
#       forward-addr: 1.1.1.1@853  # or your preferred DoT upstream

# Set in .env:
DNS_UNBOUND_HOSTS=127.0.0.1
DNS_PER_QUERY_DNSEC=true
```

### Docker Compose

```yaml
services:
  unbound:
    image: mvhun/unbound:latest
    volumes:
      - ./deploy/unbound/unbound.conf:/etc/unbound/unbound.conf:ro
    ports:
      - "53:53/tcp"
      - "53:53/udp"
    restart: unless-stopped

  app:
    environment:
      - DNS_UNBOUND_HOSTS=unbound
      - DNS_PER_QUERY_DNSEC=true
```

### Verification

```bash
# Health check
curl http://localhost:3000/api/v1/health | jq '.dns.dnssecValid'
# Should return true

# Test per-query DNSSEC
dominus score available-domain.example.com | jq '.scoreResult.breakdown.intrinsic.dnssec'
# Should show "valid" for Available domains
```

## Related ADRs

- **ADR-0072** — Unbound Resolver as Single Source of Truth (superseded/completed)
- **ADR-0073** — DNSSEC Per-Query Validation (now default ON)
- **ADR-0061** — DNSSEC Fail-Closed (reinforced)
- **ADR-0059** — DNS Circuit Breaker (simplified to single resolver)

## Rollback Plan

If critical issues arise, temporarily re-enable fallback by:

1. Reverting `provider-factory.ts` to previous version
2. Setting `DNS_UNBOUND_ENABLED=false` (will use NodeDnsProvider)
3. This is a **temporary measure only** — architecture decision is final