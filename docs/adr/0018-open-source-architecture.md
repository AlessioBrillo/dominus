# ADR-0018: Open-Source Architecture

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Superseded (see ADR-0025, ADR-0026) |
| **Date** | 2026-06-09 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | — |

## Context

DOMINUS started as a personal domain-investment tool. As the codebase matured,
it became clear that its architecture — zero-cost APIs, SQLite portability,
provider abstraction — is inherently suited for open-source distribution.
However, nothing in the repository *explicitly* acknowledged this. A fork
would have discovered the customisation points only by reading the source.

The goal of this ADR is to formalise the open-source nature of DOMINUS as a
first-class architectural principle, and to document the specific design
patterns that enable forking, customisation, and scaling.

## Decision Drivers

1. **Forkability** — a clone of the repository should work immediately with
   sample data, and every behavioural knob should be reachable without editing
   source files.
2. **Customisability** — every provider, signal, threshold, and weight should
   be replaceable or tunable without forking the core logic.
3. **Scalability** — the same codebase should serve a single user on a laptop
   and an enterprise managing thousands of domains.
4. **Transparency** — no black-box algorithms, no hidden API calls, no
   telemetry, no vendor lock-in.
5. **Zero-cost** — all external data sources must be free or file-based.
   The tool must never require a paid subscription to function.

## Decision: Open-Source First

DOMINUS is designed as an **open-source first** project. Every architectural
decision is evaluated against the question: *"Does this make it easier or
harder for someone to fork, customise, and deploy on their own terms?"*

### Design Patterns That Enable This

#### 1. Provider Abstraction (ADR-0004)

Every external dependency is behind a TypeScript interface. Swapping a provider
is a one-file change in `src/app/composition-root.ts`. This means:

- A fork can replace `ManualKeywordProvider` with a Google Ads API provider
  without touching the scoring engine
- A fork can replace `NodeDnsProvider` with a Route53-based check
- A fork can add a `TrademarkProvider` for WIPO or national registries

#### 2. Configuration Over Code

All tunable parameters are exposed via environment variables, not hardcoded
constants. The Zod schema in `src/config.ts` is the single source of truth.
Adding a new parameter requires:
1. A new entry in the Zod schema (with a sensible default)
2. A new entry in `.env.example` (with documentation)
3. Reading the value where needed

No constants are hidden in source files. Every scoring signal threshold, TLD
bonus, trademark matching parameter, and pipeline behaviour can be adjusted
through `.env`.

#### 3. File-Based Data Sources

Keyword volumes and comparable sales are read from local JSON/CSV files.
There is no mandate to connect a specific API. Users can:
- Use the sample files in `examples/` to evaluate the tool
- Export keyword data from any source (Google Ads, Ahrefs, Semrush)
- Export comparable sales from any source (NameBio, Estibot, own records)
- Write a script to produce the expected format

#### 4. SQLite Portability

The database is a single file (`dominus.db`). It is the entire portfolio,
configuration, and run history in one transportable unit. There is no server
process, no connection string, no cloud dependency. A fork can:
- Copy the file to another machine and keep working
- Back it up with a single `cp` or `VACUUM INTO`
- Inspect it with any SQLite client

#### 5. Docker and Multi-Profile Deployment

The Docker Compose setup supports development, production, and scheduler
profiles. A fork can:
- Run `docker compose up` for a quick start
- Add `-f docker-compose.prod.yml` for production resource limits
- Deploy to Kubernetes using the reference manifests in `deploy/`
- Use systemd or PM2 on bare metal

#### 6. Semantic Versioning and Public API

DOMINUS follows SemVer. The public API includes CLI commands, REST endpoints,
provider interfaces, and the database schema (via numbered migrations). A fork
can depend on a specific version without fear of breaking changes.

### Explicitly Documented Customisation Points

The following are now documented as customisation points in the README and
`docs/customization/`:

| Layer | Customisation | Mechanism |
|-------|---------------|-----------|
| Scoring | Weights | `SCORING_WEIGHTS_OVERRIDE` JSON file |
| Scoring | Signal thresholds | Env vars (SCORING_IDEAL_LENGTH, etc.) |
| Scoring | TLD bonuses | `TLD_BONUSES_PATH` JSON file |
| Trademark | Match policy | Env vars (TRADEMARK_MIN_TOKEN_LENGTH_FUZZY, etc.) |
| Pipeline | Keyword TLD | `DEFAULT_KEYWORD_TLD` env var |
| Pipeline | Run retention | `PipelineRunService` constructor param |
| All providers | Implementation | Swap in `composition-root.ts` |
| All providers | Availability | New file implementing the interface |
| API | Authenticaiton | `API_KEYS` env var |
| Notifications | Channels | `NOTIFIER_*` env vars |
| Scheduling | Cadence | CRON env vars |
| Budget | Buy cap | `BUY_MAX_ABSOLUTE_CAP` env var |
| Portfolio | Drop logic | `DROP_SCORE_THRESHOLD` env var |

## Consequences

### Positive

- A fork can make deep behavioural changes without touching source code
- The repository serves as both a working tool and a reference implementation
- New contributors can understand the architecture from its explicit
  documentation, not by reverse-engineering
- Scaling from personal to enterprise use is a configuration change, not a
  rewrite
- Security posture is clear: no telemetry, no third-party code execution,
  no unexpected network calls

### Negative

- Supporting multiple configuration paths increases the test surface
- Documenting every customisation point is ongoing maintenance
- Some users may find the number of environment variables overwhelming (mitigated
  by sensible defaults and the `.env.example` reference)

### Neutral

- The architecture-guardian skill in `.claude/skills/` now enforces open-source
  readiness as a review criterion
- ADR-0018 retroactively formalises a design that was already largely in place
