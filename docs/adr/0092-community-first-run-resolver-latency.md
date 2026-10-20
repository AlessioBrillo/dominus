# ADR-0092: The community first run does not wait for a resolver that is not there

## Metadata

| Field          | Value                                                     |
| -------------- | --------------------------------------------------------- |
| **Status**     | Accepted                                                  |
| **Date**       | 2026-10-20                                                |
| **Authors**    | Alessio Brillo                                            |
| **Deciders**   | Alessio Brillo                                            |
| **Supersedes** | —                                                         |
| **Relates to** | ADR-0002, ADR-0072, ADR-0075, ADR-0076, ADR-0091         |
| **Project**    | DOMINUS                                                   |

## Context

Unbound is the single source of truth for DNS (ADR-0072, ADR-0075). The
application waits for the resolver to become healthy and to prove DNSSEC
validation before it accepts traffic, and in cloud mode (`DNS_UNBOUND_STRICT`
on) it refuses to start without it.

The wait was configured with a single default: 30 seconds, in every
deployment mode. In the community edition that default is paid on every
command, by every user, for a resolver that in most community installations
is not there at all: the self-hosted "Personal" profile in the README is the
CLI alone, with no Unbound sidecar.

The measured cost, from the first run of the published artifact
(`scripts/verify-release.mjs`, ADR-0091): the CLI spent ~30 seconds in
"Unbound readiness check failed — retrying" before falling back to the Node
resolver. The command that the README's Quick Start advertises —
`npx dominus-oss@latest score vintagecoffee.com` — took half a minute
before it printed anything. The fallback was correct; the latency was not.

The fallback is already the accepted community posture (ADR-0076): it is
explicitly non-strict, it never produces an `Available` verdict that the
DNSSEC-validating resolver did not produce, and the strictness of the
production path is unaffected. The wait changes nothing about the outcome in
the community edition; it only changes how long the user waits to reach the
same outcome.

## Decision Drivers

1. **The first run is the product's first impression.** The public release
   makes `npx dominus-oss` a one-command experience. A half-minute of
   silence before the first output reads as a hang, and users who read it
   that way do not run the command again.
2. **The wait must not weaken the guarantee.** DNSSEC validation must stay
   mandatory for anything the product calls `Available`. Nothing here may
   change what a verdict means.
3. **The two modes want opposite defaults.** Cloud needs the long wait (the
   resolver must be there, and a sidecar that is still booting deserves the
   time). The community edition does not (the resolver is optional there).
4. **The change must be visible in the configuration.** A hidden latency
   change is a surprise; a documented default that differs per mode is a
   fact.

## Considered Options

### Option A: One default for both modes (status quo)

**Advantages:** simple.

**Disadvantages:** the community edition pays 30 seconds for a resolver that
is usually absent, on every command.

### Option B: Skip the readiness wait entirely in the community edition

**Advantages:** the fastest possible first run.

**Disadvantages:** it also skips the Unbound configuration validation
(`validator` module, `val-permissive-mode: no`), which is a diagnostic a
self-hoster with a broken `unbound.conf` would want. A misconfigured
resolver in a Docker deployment would degrade more quietly.

### Option C: A mode-dependent default for the readiness timeout

**Advantages:** the readiness path stays intact — the health check, the
DNSSEC proof, the configuration validation — and only its budget changes.
A resolver that is starting up still gets its chance; a machine with no
resolver stops waiting after five seconds instead of thirty.

**Disadvantages:** two defaults to remember, and the community figure is
still a wait.

## Decision

**Option C.**

- `DNS_UNBOUND_READINESS_TIMEOUT_MS` defaults to **30 000 ms in cloud mode**
  and **5 000 ms in the community edition**. The deployment mode is the one
  the configuration already computes (`detectCloudMode`: a `DATABASE_URL`
  or an `AUTH_PROVIDER` other than `env`).
- The mode detection is the same one that drives `DNS_UNBOUND_STRICT`, so
  the two defaults cannot disagree: the mode that is strict about the
  resolver is the mode that waits longest for it.
- An explicit value always wins. The variable stays overridable, and the
  `.env.example` entry documents both figures.
- Nothing else changes: the readiness path, the health check, the DNSSEC
  proof, the configuration validation and the strict-mode refusal all
  behave exactly as before.

## Consequences

### Positive

- The community first run reports in seconds instead of half a minute, with
  the same verdict and the same guarantees.
- The cloud path is untouched: a resolver that is still booting still gets
  the thirty seconds it needs, and a missing resolver still fails the boot.
- The fallback still never produces an `Available` verdict that the
  DNSSEC-validating resolver did not produce (ADR-0002, ADR-0076).

### Negative

- A resolver that becomes available between the fifth and the thirtieth
  second is no longer waited for in the community edition. The
  `FallbackResolver` re-evaluates the primary on every call, so the
  resolver is picked up as soon as it is healthy; the window is a slower
  first lookup, never a wrong verdict.
- Two defaults exist. The test
  (`src/__tests__/config-readiness-timeout.test.ts`) pins both, so they
  cannot drift.

## Links

- `src/config.ts` — the mode-dependent default.
- `src/__tests__/config-readiness-timeout.test.ts` — the pinned defaults.
- `src/app/provider-factory.ts` — the readiness wait and the fallback.
- `scripts/verify-release.mjs` — the verification that measured the latency.
