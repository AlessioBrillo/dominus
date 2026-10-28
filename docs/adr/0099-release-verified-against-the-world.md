# ADR-0099: The release is verified against the world — the installer gate and the canary that blocks a tag

## Metadata

| Field          | Value                                                    |
| -------------- | -------------------------------------------------------- |
| **Status**     | Accepted                                                 |
| **Date**       | 2026-10-28                                               |
| **Authors**    | Alessio Brillo                                           |
| **Deciders**   | Alessio Brillo                                           |
| **Supersedes** | —                                                        |
| **Relates to** | ADR-0006, ADR-0091, ADR-0097, ADR-0098                    |
| **Project**    | DOMINUS                                                  |

## Context

On 2026-10-27 the repository announced `1.3.3` and every gate was green.
Measured against the world, it was not releasable:

| What a stranger does | What happened |
|---|---|
| `curl …/releases/latest/download/install.sh \| sh` | **404** |
| `iwr …/releases/latest/download/install.ps1 \| iex` | **404** |
| downloads `dominus-oss.tgz` + checksum | **404** |
| `npx dominus-oss@latest` | **E404** — the package was never published |
| `npm run release:doctor` | **FAIL** — the tag did not point at HEAD |

The installers had been merged after the `v1.3.3` tag, so no release had ever
carried them. The npm publish had failed three times on an account setting.
The release workflow verified only npm — the channel that had never worked —
and never verified the GitHub Release, the channel that did.

Three defects were found in the code that was supposed to catch this:

1. `scripts/install.sh` and `scripts/install.ps1` ran
   `npm install --prefix` **without `-g`**, so the binary landed in
   `<prefix>/node_modules/.bin` while the scripts looked for
   `<prefix>/bin/dominus` (and `<prefix>\bin\dominus.cmd`). They printed
   "installed, but not on PATH" and exited **0**: a silent success with no
   usable command. Neither installer had a single test.
2. `scripts/check-published-install.mjs` read `fixturePort` **before**
   `startFixture()` resolved, so the CLI was pointed at port `0` and the
   decision said "TM unverified" — while the assertion only looked for the
   label `Recommended:`. Its time budget measured the interval between two
   adjacent statements (always ~0 ms), and it appended `.sha256` to a
   `releases/tag/…` URL, which answered 404.
3. `scripts/check-trademarks.mjs` documented that it "fails the release
   workflow if the endpoint drifts" (ADR-0098 repeated the claim). No
   workflow ran it. The canary had never run anywhere.

The pattern is the one ADR-0097 named: **a gate that checks the repository
against itself cannot see the world.** The trademark gate is the one feature
the product cannot be without (Principle 6), and it depends on free public
endpoints that are not ours; the USPTO endpoint had already moved once and
the failure was read as "this mark does not exist" until v1.3.2.

## Decision Drivers

1. **The first command a stranger runs must work.** It is the product's
   front door; a 404 is a worse first impression than a missing feature.
2. **A gate that cannot run is not a gate.** A script whose header claims a
   workflow runs it, and which no workflow runs, is a document.
3. **The one non-negotiable gate must block a release when the world
   changes.** A trademark source that has drifted must stop a tag, not be
   discovered by a user.
4. **A channel that depends on an account setting cannot be the only
   channel.** The GitHub Release is downloadable without an account and
   carries the same artifact.
5. **No silent success.** An installer that installs nothing must exit
   non-zero.

## Considered Options

### Option A: fix the npm trusted publisher and keep npm as the only channel

**Advantages:** the smallest change; `npx` is the idiom Node users expect.

**Disadvantages:** the setting has already failed three publishes; the
channel remains one account action away from being no channel at all, and
nothing verifies the GitHub Release that already exists.

### Option B: verify the release with a checklist before each tag

**Advantages:** no code, and a human can see what a machine cannot.

**Disadvantages:** the 404 existed while the checklist said the channel was
done. A document is not a gate (ADR-0090, ADR-0091).

### Option C: gates around the channel, and a canary that blocks the tag (chosen)

1. The installer is exercised against a **local release channel**: a real
   tarball served over HTTP, the real `install.sh`/`install.ps1`, a
   throwaway prefix, a working `dominus score`, and a corrupted checksum
   that must be refused.
2. The **published** channel is exercised after the publish: the alias
   tarball, its checksum, both installers and the first command.
3. The live trademark canary **blocks the release job**; a daily schedule
   opens an issue when the endpoint drifts between releases.
4. The GitHub Release is the primary channel and is verified even when the
   npm publish fails.

**Advantages:** every claim is a command with an exit code; the first
command works on both platforms; endpoint drift stops a tag; the npm
failure can no longer hide the channel users download.

**Disadvantages:** the release now depends on a live third-party endpoint
(intentional); the installer test adds about a minute to the gate; a
transient network failure can block a release until it is re-run.

### Option D: publish only to npm and remove the installers

**Advantages:** one channel, one code path.

**Disadvantages:** the package has never been published; removing the
channel that works to keep the one that does not is the wrong direction.

## Decision

**Option C.**

1. **`npm install -g`** in both installers: the binary lands in
   `<prefix>/bin` on Linux/macOS and in the prefix on Windows, which is what
   the scripts and the README say.
2. **`npm run test:installers`** (`scripts/test-installers.mjs`) runs the
   real installer against a local HTTP server that serves the real tarball
   and checksum, on Linux and Windows, and asserts a working `dominus score`
   and a refused corrupted checksum. It is part of `npm run gate` and of a
   dedicated CI matrix job.
3. **`check:published-install` is fixed and wired** into the release
   workflow: the fixture starts before its port is read, the time budget
   measures the command, a release tag URL resolves to the alias tarball,
   and the decision must carry a `clear` trademark verdict.
4. **The live canary gates the tag.** `trademark-canary` runs
   `check:trademarks` before the `release` job; the scheduled
   `trademark-canary.yml` opens an issue on failure and closes it on the
   next green run.
5. **The GitHub Release is primary; npm is best-effort** until the trusted
   publisher is configured. The README says so, and the release workflow
   verifies the GitHub channel with `always()` so an npm failure cannot skip
   it.
6. **The release asserts its own assets**: the alias tarball, its checksum
   and both installers must be attached before the channel is verified.

## Consequences

### Positive

- A stranger's first command works on Linux, macOS and Windows.
- A release that advertises a channel that does not answer cannot be
  published: the post-publish job fails on the 404.
- A drifted trademark endpoint blocks the tag, and between releases it
  leaves an issue instead of a silent degradation.
- The installer defect (silent success, no command) cannot return: the
  gate fails when the binary is not where the script says it is.

### Negative

- A release now requires the live USPTO endpoint to answer. This is the
  intended trade-off: the alternative is publishing a tool that recommends
  nothing, or worse, one that clears domains without a gate.
- The gate is about a minute slower.
- The canary is network-dependent; a transient failure blocks a release
  until it is re-run.

### Neutral

- No product feature changes. The scoring engine, the pipeline and the
  Cloud surface are untouched.
- The npm channel remains available and is still verified when it works;
  it is simply no longer the only channel and no longer the primary one.

## Links

- [ADR-0006](0006-trademark-gate-mandate.md) — the gate is not optional.
- [ADR-0091](0091-verified-published-artifact.md) — the published artifact is
  verified, not assumed.
- [ADR-0097](0097-cli-front-door-and-release-state.md) — the first command
  and the release state.
- [ADR-0098](0098-uspto-endpoint-migration.md) — the endpoint migration and
  the canary this ADR makes real.
