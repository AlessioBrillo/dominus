# ADR-0097: The front door: a decision command that answers, and a release state that is real

## Metadata

| Field          | Value                                                |
| -------------- | ---------------------------------------------------- |
| **Status**     | Accepted                                             |
| **Date**       | 2026-10-22                                           |
| **Authors**    | Alessio Brillo                                       |
| **Deciders**   | Alessio Brillo                                       |
| **Supersedes** | —                                                    |
| **Relates to** | ADR-0002, ADR-0006, ADR-0012, ADR-0091, ADR-0095     |
| **Project**    | DOMINUS                                              |

## Context

The repository was, on 2026-10-22, in a state that every gate called
green and that no user would have called working.

The **first command** of the project — the one the README opens with, the
one a stranger runs first, the one every user meets — was this:

```
$ dominus score vintagecoffee.com
   14.8 KB of JSON log lines on stdout
   Score: vintagecoffee.com
     Expected value:    €246.13
     ...
```

Measured, not estimated:

| | before | after |
|---|---|---|
| wall clock | 12.4 s | ~2.5 s |
| stdout | 14.8 KB (≈400 bytes of decision) | the decision, alone |
| files written | `data/dominus.db`, 753 KB | none |
| processes started | the job worker | none |
| resolver probe | 5 s of Unbound retries, four stack traces | none |

The cause was structural, not cosmetic: `src/cli.ts` built the **whole
application** for every command. The full composition root opens the
database, applies the migrations, starts the in-process job worker
(ADR-0023), probes the Unbound resolver for readiness, refreshes the IANA
RDAP bootstrap and probes the RDAP consensus second leg. A scoring command
needs none of that. It needs the scoring engine and the trademark gate.

Two more facts made this the right moment for the decision:

1. **The release was a phantom.** `package.json` announced `1.3.1`, the
   CHANGELOG had the section, the Terraform example pinned the image tag
   `v1.3.1` — and there was no `v1.3.1` tag, no image and no package. The
   gates were green because they check the repository against itself, and
   the repository was internally consistent. The first `terraform apply`
   would have pulled an image that does not exist.
2. **The trademark gate failed open.** The USPTO provider answered a
   non-OK HTTP status with an *empty result set*: "this mark does not
   exist". The endpoint it calls (`POST https://tmsearch.uspto.gov/tmsearch`)
   answers `405 Method Not Allowed` from Amazon S3 — the path now serves
   the static assets of the search site — so the gate was clearing domains
   on a request that never happened. ADR-0012 says a partial enumeration of
   a register is weaker evidence than no enumeration at all; the code did
   the opposite.

## Decision Drivers

1. **A decision command must answer, not boot.** The first command of a
   tool is the product's front door: it decides whether the next command
   is worth typing.
2. **stdout is the output channel.** A command whose output cannot be
   piped cannot be scripted, and the project's whole promise is a decision
   another program can consume.
3. **A command that answers a question writes nothing down.** The record
   is the point of the other commands; `score` is a question.
4. **A gate that cannot see the world is not a gate.** The repository's
   checks verify the repository. The release state lives outside it.
5. **A trademark source that cannot answer must not clear a domain.**
   Principle 6 is not negotiable, and "no answer" is not "clear".

## Considered Options

### Option A: keep the full composition root and clean up the output

Format the human block better, send the logs to stderr, and leave the
boot cost alone.

**Advantages:** the smallest diff; nothing about the architecture moves.

**Disadvantages:** the command still opens a database, still starts a
worker and still waits five seconds for a resolver it never queries. The
noise was a symptom; the cause was that a question and an application were
built by the same code path.

### Option B: one composition root, built lazily per command

Make every service lazy and resolve it when the invoked command asks for
it.

**Advantages:** one root, no duplicated wiring.

**Disadvantages:** every one of the twenty-two command registrations takes
its services as constructor arguments, so laziness has to be pushed through
all of them (a thunk per service, or a proxy). The result is a
composition root that is hard to read and a diff that touches everything -
for one command that does not need most of it.

### Option C: profiles, resolved from the command line (chosen)

The CLI resolves a **profile** before it builds anything:

- the **catalog** profile (`--help`, `--version`, a bare `dominus`): the
  command line and nothing else — no application, no database, no worker;
- the **decision** profile (`score`): the scoring engine and the trademark
  gate, no database, no worker, no resolver, no RDAP;
- the **full** profile: everything else, unchanged.

The two application profiles share the provider stack (the trademark
sources are built in one module, `src/app/trademark-stack.ts`, and the
server wraps them with the database cache while the decision path uses them
raw), so they cannot drift. The catalog profile registers the *same*
commands, with the same options and the same descriptions, through the
same registration function — a test compares the two command lines, so the
help cannot drift from the tool either.

**Advantages:** the decision path is small, obvious and fast; the full path
is untouched; the seam is explicit and testable; adding a second decision
command is one line in `DECISION_COMMANDS` and one registration in the
decision program.

**Disadvantages:** there are three roots; a command that needs a service it
does not have must move to the full profile.

### Option D: for the release state, more repository checks

Add a check that compares the version with the tags, the CHANGELOG and the
Terraform example.

**Advantages:** fast, offline, deterministic.

**Disadvantages:** it still compares the repository with itself. The
missing artifact is exactly the thing the repository cannot see. The
release doctor queries the world (the tags on the remote, the npm
registry, the image registry) in addition.

## Decision

**Option C**, plus **Option D's repository checks inside a doctor that
also looks outside**, plus the fail-closed trademark providers.

1. **The CLI has three profiles** (`src/cli/profile.ts`). The catalog
   profile builds the command line and nothing else. The decision profile
   builds `src/app/decision-root.ts`: the engine, the gate, and nothing
   else. The full profile is the existing composition root.
2. **The logs go to stderr, the decision goes to stdout** (`src/logger.ts`).
   The CLI entry point (`src/cli.ts`) is a thin wrapper that sets the
   destination *before* the application is imported, because several
   modules take their logger at import time.
3. **`dominus score --json`** prints the decision as an object: the
   numbers, the trademark verdict and the recommendation.
4. **The trademark providers fail closed.** A non-OK status, a body that
   is not JSON and a shape the provider cannot read are errors, so the
   failover tries the next source and the gate reports `Unverified` when
   every source is down. An unverified domain is never recommended.
5. **The release state is checked against the world**
   (`scripts/release-doctor.mjs`): a clean tree, a tag for the version, the
   tag on the remote, the internal consistency, and with `--remote` the
   package on npm and the image in the registry.
6. **The quickstart is a gate** (`scripts/check-quickstart.mjs`): the
   advertised command is executed in a throwaway directory and its
   contract is asserted - exit 0, no log lines on stdout, the five
   numbers, nothing written to the disk, a time budget - and the output
   documented in the README is compared with the output produced.

## Consequences

### Positive

- The first command answers in about two seconds, writes nothing and can
  be piped.
- A domain whose trademark was not checked is never recommended. The
  conservative behaviour is now the behaviour of the code, not only of the
  documents.
- A release that announces a version without a tag, an image or a package
  is reported by a command, not discovered by a user.
- The documented quickstart is verified by the gate, so it cannot rot
  silently.

### Negative

- Two composition roots. The seam is explicit and covered by a test, but
  it is a seam.
- The decision path does not use the database cache of the providers, so a
  repeated lookup is not cached. For a one-shot command there is no second
  lookup to cache for.
- With the USPTO endpoint dead, the gate reports `Unverified` for every
  domain until the endpoint is migrated (or until EUIPO credentials are
  configured). The tool says so instead of pretending. **This is the next
  blocker for the paid launch**, and it is an upstream change, not a code
  change.

### Neutral

- The exit code contract is unchanged: 0 when a decision was produced, 1
  on an invalid input or a failure. A "pass" verdict is a decision, not an
  error.

## Links

- [ADR-0002](../adr/0002-scoring-engine-design.md) — the conservatism
  principle.
- [ADR-0006](../adr/0006-trademark-gate-mandate.md) — the gate is not
  optional.
- [ADR-0012](../adr/0012-trademark-matching-policy.md) — a partial
  enumeration is weaker evidence than none.
- [ADR-0091](../adr/0091-verified-published-artifact.md) — the published
  artifact is verified, not assumed; this ADR applies the same rule to the
  release state.
- [ADR-0095](../adr/0095-cloud-acceptance-suite.md) — production parity
  before the first paid deployment.
