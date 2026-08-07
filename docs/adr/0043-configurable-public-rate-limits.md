# ADR-0043: Configurable Per-IP Rate Limits on the Public Namespace

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-07 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0030, ADR-0026, ADR-0027 |
| **Project** | DOMINUS |

## Context

The `/public` namespace is the only unauthenticated surface of the API
(score pages, sitemap.xml, robots.txt, and the POST /public/scores
endpoint). It is the most exposed entry point of the service, so it already
carries per-IP rate limits: a per-IP cap across the whole namespace, a
stricter per-IP per-domain cap on the expensive `valuate` route, and a cap
on score creation. On a single-VM Cloud deployment (ADR-0026, ADR-0027)
the limits were compiled-in constants in `public-router.ts`.

Two problems with hardcoded limits over time:

1. **Operations** — the fair cap depends on the deployment. A busy
   high-traffic self-hosted install may legitimately outgrow 30
   requests/minute/IP for page loads, while a tightly-scoped install may
   want stricter DOMAIN/POST caps. Neither was tunable without a code
   change.
2. **Drift** — the config schema (`RATE_LIMIT_WINDOW_MS` etc.) and the
   router constants were two sources of truth; there was no test locking
   the router defaults to a documented, operator-visible setting.

## Decision

**Expose the public per-IP rate limits as environment variables and pass
them into `createPublicRouter` through its options, falling back to the
previously compiled-in defaults when unset.**

- New config schema keys (all with defaults equal to the old constants, so
  behaviour is unchanged unless an operator opts in):

  | Key | Default | Meaning |
  |-----|---------|---------|
  | `PUBLIC_RATE_LIMIT_WINDOW_MS` | `60000` | whole-namespace window |
  | `PUBLIC_RATE_LIMIT_MAX` | `30` | whole-namespace requests/IP/window |
  | `PER_DOMAIN_RATE_LIMIT_WINDOW_MS` | `60000` | per-domain window |
  | `PER_DOMAIN_RATE_LIMIT_MAX` | `5` | same-domain requests/IP/window |
  | `POST_RATE_LIMIT_WINDOW_MS` | `60000` | score-creation window |
  | `POST_RATE_LIMIT_MAX` | `10` | score creations/IP/window |
  | `POST_BODY_MAX_BYTES` | `1000` | POST /scores body cap |

- `createPublicRouter` gains an optional `rateLimits` field on
  `PublicRouterOptions`; every limit falls back to the compiled-in default
  when the option is absent, keeping the router callable from tests and
  other consumers without a full config object.
- The composition root (`src/index.ts`) wires the config keys into that
  option, so `dotenv`/environment overrides flow straight into the router.
- Per-IP keying is unaffected: limits key on `req.ip` honouring
  `TRUST_PROXY_DEPTH` (default 1), the distributed `RedisRateLimitStore`
  keeps budgets shared across replicas, and the stored window is derived
  from the same `PUBLIC_RATE_LIMIT_WINDOW_MS` value.

### Options considered and rejected

- **Keep the constants compiled-in only** — rejected: no operator control,
  and the existing `config.test.ts` drift-lab (DNS_*) shows un-tested
  defaults drift out of sync with the documented schema.
- **Read `process.env` directly inside the router** — rejected: the
  router is pure of environment (provider-abstraction pattern, ADR-0004);
  the composition root owns environment access.
- **Give each route its own TPS bucket** — rejected: the layered cascade
  (namespace → domain → POST) already covers the angles; adding more knobs
  without a demonstrated need violates cost discipline.

## Consequences

### Positive

- Operators can tune the anonymous-stack caps via `.env` with no code
  change; defaults preserve current behaviour exactly.
- The defaults are locked by tests and documented in `.env.example` and
  the schema, ending the drift risk.

### Negative

- Seven new config keys increase the schema surface; each is a well-typed
  coerced number with documented defaults and bounds.

### Risks and mitigation

- **Operator sets absurd values** (e.g. `PUBLIC_RATE_LIMIT_MAX=0`) —
  schema bounds reject non-positive values at startup (`ConfigError`),
  failing fast rather than silently disabling protection.
- **Overrides diverge between replicas** — same risk as the base
  rate limits; resolved by the shared Redis store and the documented
  deployment config being single-sourced.