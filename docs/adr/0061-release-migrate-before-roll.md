# ADR-0061: Release Migrate-Before-Roll — Explicit Schema Migrations with a Dedicated Timeout

## Metadata

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| **Status**     | Accepted                                         |
| **Date**       | 2026-08-18                                       |
| **Authors**    | AlessioBrillo                                    |
| **Deciders**   | AlessioBrillo                                    |
| **Supersedes** | N/A                                              |
| **Relates to** | ADR-0005, ADR-0027, ADR-0054                     |
| **Project**    | DOMINUS                                          |

## Context

Until v1.1.0, schema migrations ran **at boot only**: the composition-root
runs `assertSchemaCompatible(applied, manifest)` and then `runMigrations()`
before health checks. The deploy pipeline (ADR-0054 era, migration gate)
rolls the new image and, on failure, auto-rolls the previous one — with the
gate blocking that rollback whenever the database is ahead of the old image's
manifest. That covers the *post-migration* failure case (release booted,
migrated, then failed health): the rollback is refused and the operator
restores from PITR or deploys the fixed release.

The remaining gap is the **migration itself failing mid-roll**:

- The new image boots, starts migrating, and dies (buggy DDL, connection
  timeout, container OOM, hung migration). The rollout then observes a failed
  health check and attempts the rollback path — at which point the gate has
  to *probe the database* to decide whether the rollback is even allowed.
- A partially applied migration set leaves the database in an ambiguous
  state: the old image cannot boot (ahead-of-manifest), the new image is
  gone, and the operator must manually determine what ran.
- Migration time is unbounded during a rollout: a hung migration occupies
  the health-check window and the rollout's own timeout, conflating "slow
  migration" with "dead migration" and making the failure diagnosis slower.

The same problem exists in reverse for the community edition (SQLite): the
image that migrates is the image that boots, and a failed local upgrade has
no rollback path at all.

## Decision Drivers

1. **Fail fast, fail before the roll** — migration failures should be
   detected *before* any image is rolled, while the old image is still
   serving; aborting a deploy must not require a PITR restore for the common
   case (the migration step itself failing).
2. **Bounded migration time** — a hung migration must be killed and reported
   after a dedicated timeout, not left to consume the rollout's window.
3. **Target image correctness** — the migration must run against the exact
   image being deployed (its manifest and migration code), never a floating
   or previous tag.
4. **Single control flow** — one self-contained script the deploy workflow
   runs, consistent with the existing migration gate, with behaviour tests
   like `test-rollout.sh`.
5. **Additive-first compatibility (migration-policy)** — the old image keeps
   serving while migrations apply; this is safe only because every migration
   is additive (ADR-0054 era policy §3), so the previous image's SQL never
   breaks against the post-migration schema.

## Considered Options

### Option A: Explicit migrate-before-roll deploy step (chosen)

A new `scripts/deploy/migrate.sh` runs *before* the roll: it pulls the
target image, runs the standalone migrate CLI (`dist/db/migrate-cli.js`) as
a `docker compose run --no-deps` container against the
live stack's database, and waits under `timeout` with a dedicated
`MIGRATE_TIMEOUT_SECONDS` (default 600 s). The CLI is a separate entrypoint
(`src/db/migrate-cli.ts`), not a main-CLI command, because the main CLI
boots dependencies — which migrate — before parsing.

- **Pros**: migration failure aborts the deploy with the old image still up
  (no rollback needed for the common case); hung migrations are killed and
  reported; the migrate container joins the stack network and uses the
  target image's own code; timeout is tunable per deploy; the workflow step
  is a single explicit `bash /tmp/dominus-migrate.sh` call.
- **Cons**: an extra deploy step and an extra script to maintain; the
  migrate container shares the api service's env (including `DATABASE_URL`
  interpolation); requires the image to be pullable before the roll (already
  guaranteed by the rollout's pull).

### Option B: Keep boot-only migrations (status quo)

Migrations run exclusively inside the new image's boot; the rollout timeout
covers both boot and migration.

- **Pros**: no new moving parts; one place where migrations run.
- **Cons**: a mid-roll migration failure lands in the ambiguous
  half-migrated state and forces gate probing during the rollback path;
  migration time is unbounded and conflated with boot/health time; the
  operator cannot distinguish "migration failed" from "app failed" from the
  deploy log alone.

### Option C: Migrate inside the roll step (post-roll migrate)

The rollout rolls the new image first, and migrations run as a separate
container *after* the roll succeeds.

- **Pros**: no wait for migration before serving.
- **Cons**: the new image boots against an un-migrated schema — the boot
  preflight (`assertSchemaCompatible`) is *designed* to refuse that, so the
  new image would fail closed at boot and the deploy would fail; it defeats
  the gate's entire premise.

## Decision

Option A. Releases get an explicit migrate-before-roll step: the workflow
runs `migrate.sh` after the gate and before the roll; on failure the deploy
aborts while the previous image keeps serving; on success the roll proceeds
and the new image's boot preflight passes. Exit contract of `migrate.sh`:
`0` — schema is up to date; nonzero — abort the deploy (do not roll).

## Consequences

### Positive

- The common failure case (migration step fails) no longer requires a PITR
  restore: the old image is still running, the deploy is aborted cleanly.
- Hung migrations are bounded by `MIGRATE_TIMEOUT_SECONDS` and killed, with
  a log line directing the operator to the migration-policy runbook.
- The migrate CLI is independently smoke-tested in CI (image-level and
  script-level behavior tests), so a broken migration path is caught before
  it reaches the node.

### Negative

- Deploys take longer: migration time is added before the roll.
- One more script and workflow step to keep in sync with the gate and the
  rollout (covered by `test-migrate.sh` behavior tests).

### Neutral

- The migrate container uses the api service's env block; `DOMINUS_IMAGE_TAG`
  is forced via the shell environment so the *target* image runs even though
  `.env` still holds the currently deployed tag.
- Boot-time migrations remain (community edition and first boot), so there
  are now two migration paths sharing one CLI implementation.