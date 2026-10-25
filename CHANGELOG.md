# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [1.3.3](https://github.com/AlessioBrillo/dominus/compare/v1.3.0...v1.3.3) (2026-10-25)


### Features

* **cli:** front door — decision and catalog profiles, fail-closed trademark gate ([#509](https://github.com/AlessioBrillo/dominus/issues/509)) ([ae6ed8e](https://github.com/AlessioBrillo/dominus/commit/ae6ed8ee84ace4b78bd0cad26fe2d46e84c4fc0a))
* **trademark:** migrate USPTO provider to prod-stage-v1-0-0 endpoint, gate answers again ([4123f7a](https://github.com/AlessioBrillo/dominus/commit/4123f7ade34c39360b4a98e810d54da988ef1bf3))


### Bug Fixes

* **ops:** the deploy workflow must parse, and the gates that say so ([8193c8b](https://github.com/AlessioBrillo/dominus/commit/8193c8b4cb643254fa01f34f38ec21791ba22e88))


### Documentation

* **release:** the npm publish state, as it is ([#505](https://github.com/AlessioBrillo/dominus/issues/505)) ([a1b53b7](https://github.com/AlessioBrillo/dominus/commit/a1b53b75e9a3e635766261ca69502a9bed481790))

## [1.3.2](https://github.com/AlessioBrillo/dominus/compare/v1.3.1...v1.3.2) (2026-10-22)

### Features

* **cli:** the decision profile. `dominus score example.com` builds the
  scoring engine and the trademark gate and nothing else: no database, no
  job worker, no resolver probe, no RDAP bootstrap. The command took 12.4
  seconds, created a SQLite database next to the user and printed 14.8 KB
  of JSON log on stdout; it now takes about two seconds, writes nothing to
  the disk and prints the decision and nothing else (ADR-0097).
* **cli:** `dominus score --json` prints the decision as a machine-readable
  object - the same numbers, the trademark verdict and the recommendation -
  on stdout alone, so it can be piped.
* **cli:** the diagnostics moved to stderr. A command's stdout is its
  output channel; the logs are still there, on the stream meant for them.
* **cli:** `--help` and `--version` are answered from the command line
  alone: they used to build the whole application (a database, its
  migrations, a job worker, a resolver probe) to print a list of commands
  — ten seconds to answer the first question a user asks.
* **gate:** the quickstart gate (`npm run check:quickstart`). It runs the
  command the README advertises, in a throwaway directory, and asserts the
  contract a reader is entitled to: exit 0, no log lines on stdout, the
  five numbers, nothing written to the disk, a time budget - and that the
  output documented in the README is the output the command produces.
* **release:** the release doctor (`npm run release:doctor`). The version
  `package.json` announces must have a tag, a clean tree and, with
  `--remote`, a package and an image. The v1.3.1 release commit sat on
  master for days with no tag and no artifact while every gate was green:
  the gates check the repository against itself, and the repository was
  internally consistent.
* **release:** the verified tarball and its checksum are attached to the
  GitHub Release, so the community edition is installable even while the
  npm trusted publisher is not configured.

### Bug Fixes

* **trademark:** the USPTO and the TSDR provider fail closed. A source
  that answers with a non-OK status, a body that is not JSON or a shape
  the provider cannot read is an ERROR now, not an empty result set: an
  empty result set claimed that no mark exists for a request that never
  happened, and the gate cleared the domain on it. A domain whose
  trademark was not checked is reported as unverified, and an unverified
  domain is never recommended (ADR-0012, Principle 6).
* **trademark:** the live USPTO Elasticsearch endpoint
  (`POST https://tmsearch.uspto.gov/tmsearch`) answers `405 Method Not
  Allowed` from Amazon S3 - the path now serves the static assets of the
  search site. The gate therefore runs unverified until the endpoint is
  migrated; the CLI says so instead of pretending the check happened.

## [1.3.1](https://github.com/AlessioBrillo/dominus/compare/v1.3.0...v1.3.1) (2026-10-20)

### Features

* **acceptance:** the Cloud acceptance suite (ADR-0095) — a production-parity
  stack (PostgreSQL with RLS, Redis, api/worker/scheduler, two tenants) and
  the assertions that only that stack can produce: tenant isolation at the
  API level and at the database level, the Stripe webhook with a signed
  event, the plan and usage surface, the GDPR export and erasure, the
  metrics token, the public legal surface, and the scheduler → queue →
  worker path. `npm run acceptance:cloud`.
* **release:** the version in the README, the Terraform example, the docker
  smoke and the CHANGELOG are checked against `package.json`
  (`npm run check:release-consistency`), so a release cannot ship with the
  repository still describing the previous one.

### Bug Fixes

* **cli:** the CLI no longer dies in PostgreSQL mode. The backtest and the
  maintenance commands checked for the SQLite handle while the command
  line was being built, and the check called `process.exit(1)`: in the
  Cloud edition (PostgreSQL) that killed every command before it could
  run — including `dominus keys create`, the documented way to mint the
  first API key of a fresh deployment, and `dominus scheduler run`. A
  command that cannot run in this deployment now refuses at invocation.
* **cli:** `dominus keys create` reads the row it wrote back for the
  tenant it wrote it for, not for the ambient tenant context. The
  bootstrap of a Cloud deployment writes outside any tenant scope on
  purpose, so the read-back found nothing and the command crashed.
* **cli:** `dominus scheduler run <job>` works. The job definitions were
  created only by the scheduler's `start()`, which only the long-running
  scheduler process calls, so the manual run answered "Unknown job".
  The definitions are now registered without arming the cron timers.
* **cli:** `dominus health` reports the PostgreSQL connection instead of
  dereferencing a null handle in the Cloud edition.
* **cli:** the CLI releases the connection pool and the Redis client when
  the command is done. In PostgreSQL mode they kept the event loop alive,
  so every command printed its output and then hung — `dominus keys
  create` returned the key and never returned to the shell.
* **ops:** the worker and the scheduler images boot again. They set
  `PORT=0`, which the shared configuration rejects ("PORT: Too small"),
  so both containers crash-looped at boot in every deployment that did
  not override the variable — the community compose stack included. The
  failure was invisible: the API kept serving.
* **release:** the npm publish is idempotent — a version that is already on
  the registry is skipped instead of failing, and the verification of the
  published artifact runs anyway (it used to be skipped with the failed
  publish, which is exactly the case it exists for).
* **release:** `image_tag` has no default in Terraform any more, so a first
  apply cannot boot a release that was current when the file was written.
* **release:** the docker smoke no longer pins a version by hand; it uses
  the published `master` image unless the operator names a tag, and it
  now asserts that the worker and the scheduler are running — a
  crash-looping container is a failed stack, not a detail of one service.
  It also builds the images from the working tree before booting them:
  `docker compose up` does not rebuild, so the pre-tag gate was testing
  whatever image was lying around and calling it the current one.
* **ops:** the deploy workflow has a production and a staging target, each
  with its own environment and secrets. A release tag deploys to
  production; staging is an explicit dispatch. The two targets share one
  composite action, so the rollout cannot drift between them.
* **release:** a new gate checks that the workflow files parse
  (`npm run check:workflows`). A workflow that does not parse fails at
  RUN time, on the event that triggers it — for the deploy workflow that
  is the push to master, where the pull request's CI never ran it. The
  staging/production split was broken exactly that way: the environment
  name is resolved before the matrix is expanded, so
  `environment: ${{ matrix.environment }}` is not a valid expression.
* **test:** the frontend suite has a 15s per-test budget instead of the
  5s default. A jsdom test that waits on timers and user interactions
  can exceed 5s on a loaded host for reasons that have nothing to do
  with the behaviour under test; a gate that reddens for the speed of the
  machine is not a gate.
* **ops:** the Terraform example no longer advertises `JWT_SECRET` (the
  application does not read it) and no longer suggests `API_KEYS` for the
  Cloud edition, where the keys live in the database and are minted with
  `dominus keys create`.
* **docs:** the npm distribution section states that the provenance
  attestation is part of the missing publish, not of what is already
  published — npm attaches it to the tarball.
* **docs:** the README quickstart has a PowerShell path, and the project
  status names the current release.

## [1.3.0](https://github.com/AlessioBrillo/dominus/compare/v1.2.0...v1.3.0) (2026-10-20)


### Features

* **billing:** collect the tax inputs and the withdrawal consent (ADR-0090) ([#498](https://github.com/AlessioBrillo/dominus/issues/498)) ([82dae3d](https://github.com/AlessioBrillo/dominus/commit/82dae3d7f838f67eedb726bcca815ef9e9c1a881))
* **billing:** the granted plan comes from the price ([0ca371e](https://github.com/AlessioBrillo/dominus/commit/0ca371ea96eb2333d8628eb5920ef50441271df3))
* **frontend:** m3/m5 pages, legal pages, and tenant credentials ([#494](https://github.com/AlessioBrillo/dominus/issues/494)) ([3e85330](https://github.com/AlessioBrillo/dominus/commit/3e85330a482c02be05d2dba0efd48a0b7c74f2a2))
* **gdpr:** data-subject export and erasure (GDPR art. 15 and 17) ([#499](https://github.com/AlessioBrillo/dominus/issues/499)) ([d2e87af](https://github.com/AlessioBrillo/dominus/commit/d2e87af5809e4b574b7951efa5cb8eaf86f22ca0))
* **legal:** server-owned legal surface for the EU operator (ADR-0090) ([#497](https://github.com/AlessioBrillo/dominus/issues/497)) ([79fd293](https://github.com/AlessioBrillo/dominus/commit/79fd29394def7b763ba069ccdf11012a7faf8b25))
* **ops:** the launch posture is measured, not promised ([a258c0d](https://github.com/AlessioBrillo/dominus/commit/a258c0d6bb8dce024ad288068ae4f4de1884b8b8))
* **ops:** the SSH ingress is closed by default ([3fd276c](https://github.com/AlessioBrillo/dominus/commit/3fd276c808d4f8a59227fc8c0c340e866c3c74e0))
* **release:** the launch gate is a command, not a document (ADR-0090) ([#500](https://github.com/AlessioBrillo/dominus/issues/500)) ([e4f470b](https://github.com/AlessioBrillo/dominus/commit/e4f470bc6a053b4e61ec80a03add28d2876ebeda))
* **release:** the published artifact is verified, not assumed ([a9271c9](https://github.com/AlessioBrillo/dominus/commit/a9271c90fe8094908f00583e0677d1a33c913ba8))


### Bug Fixes

* **ci:** green trunk — e2e strict-mode drift, smoke gate, credential-shaped URIs ([#495](https://github.com/AlessioBrillo/dominus/issues/495)) ([69a9293](https://github.com/AlessioBrillo/dominus/commit/69a9293c5da8ff118d66e32bccd3f0a0d24b1462))
* **deps:** bump vitest to 4.1.12 and unbind the loopback test from the ephemeral port range ([#501](https://github.com/AlessioBrillo/dominus/issues/501)) ([59e6da0](https://github.com/AlessioBrillo/dominus/commit/59e6da090a1eafa77e6bb71150c335a49cb3b1d4))
* **docker:** the build context must carry the repository's npm rules ([#503](https://github.com/AlessioBrillo/dominus/issues/503)) ([e2e7bff](https://github.com/AlessioBrillo/dominus/commit/e2e7bff4cc6db0316933b499d5c0ffb172306778))
* **ops:** the restore drill proves the data, not the layout ([e4bc317](https://github.com/AlessioBrillo/dominus/commit/e4bc3179b0fede84d08b3345dba875673ff720d4))


### Performance Improvements

* **dns:** the first run does not wait for a missing resolver ([2cb2d26](https://github.com/AlessioBrillo/dominus/commit/2cb2d26f030913fee8301b4f47997d6600913b2b))


### Documentation

* **release:** the launch state and the support promise ([25f91ca](https://github.com/AlessioBrillo/dominus/commit/25f91ca41931cd152904e61d9caff314700af3d7))

## [1.2.0](https://github.com/AlessioBrillo/dominus/compare/v1.1.0...v1.2.0) (2026-10-14)

### Features

* **automation:** post-acquisition pipeline with for-sale site and indexing
  (ADR-0083, [#473](https://github.com/AlessioBrillo/dominus/pull/473)) —
  journaled steps in `post_acquisition_steps`, an append-only
  `automation_audit` trail, a kill switch (`AUTOMATION_ENABLED`, default
  off) and dry-run (`AUTOMATION_DRY_RUN`, default on). New `POST_ACQUISITION`
  job type on the existing queue; the purchase and won-auction paths now
  trigger the pipeline instead of the old fire-and-forget auto-list.
  `listing`, `site` and `indexing` steps execute: a landing page is
  generated from scoring data and published at
  `/public/for-sale/<domain>` with Schema.org `Offer` markup, included in
  the sitemap, and submitted to IndexNow (`INDEXNOW_KEY`), with contact via
  `AUTOMATION_CONTACT_EMAIL`. Also fixes `AUTO_LIST` / `POST_ACQUISITION`
  job handlers being unregistered by the worker, which previously
  dead-lettered every enqueued job.
* **observability:** request correlation ids propagated through logs and
  errors ([#475](https://github.com/AlessioBrillo/dominus/pull/475)) —
  inbound `X-Request-Id` is echoed when well-formed and otherwise replaced
  with a generated UUID, the id is bound into AsyncLocalStorage so it
  reaches the 113 existing `getLogger()` call sites via a pino mixin, and
  error bodies now carry `requestId`. Inbound values are length-capped
  (200 chars) and charset-restricted, since an untrusted id would otherwise
  be written into response headers and structured logs.
* **observability:** warn when `TRUST_PROXY_DEPTH` is unset behind a reverse
  proxy — the value decides whose `X-Forwarded-For` is believed, which
  decides the key every per-IP rate limit uses, and unset reads the same as
  "no proxy" so nothing surfaced the mistake.

### Bug Fixes

- **portfolio:** de-flake day math across the UTC midnight boundary
  ([#474](https://github.com/AlessioBrillo/dominus/pull/474)) — two suites
  read the wall clock while comparing UTC calendar days, so any CI run that
  crossed 00:00 UTC failed for reasons unrelated to the diff. Anchored to
  mid-UTC-day.
* **docs:** `npx dominus` in the deployment matrix pointed at a package name
  that is not published and is held by an unrelated project. The community
  CLI now installs as `dominus-oss@latest`, and the Quick Start documents
  both the npm and source paths. The README also gained the AGPL §6(b)
  Corresponding Source offer that an npm installation of `dist/` requires.
* **docs:** ROADMAP claimed frontend coverage thresholds of 50/50/50 while
  `frontend/vitest.config.ts` enforces 70/70/70/60.
* **ci:** release publication moved to a dedicated `release.yml`. The old
  step in `deploy.yml` degraded silently to `--generate-notes` when the
  CHANGELOG section was missing, which shipped a release page with no
  notes. A missing or empty section now fails the workflow, and npm is
  published with OIDC trusted publishing plus `--provenance` instead of a
  long-lived token.
* **ci:** Dependabot blocked from proposing `vitest` ≥ 5, which removes the
  `bench` export used by `src/benchmarks/*.bench.ts` and turns `vite` into
  a required non-optional peer that `.npmrc`'s `legacy-peer-deps=true` will
  not install — a deterministic break of every `vitest run`.

## [1.1.0](https://github.com/AlessioBrillo/dominus/compare/v1.0.0...v1.1.0) (2026-10-12)


### ⚠ BREAKING CHANGES

* **dns:** DNS_UNBOUND_ENABLED=false no longer supported.
Community edition must run Unbound locally (Docker or host).
* **dns:** DNS_UNBOUND_ENABLED=false no longer supported. Community
edition must run Unbound locally (Docker or host). Set DNS_UNBOUND_HOSTS to
your Unbound instance(s).

### Features

* add dns-monitor service for telemetry and stability ([7f3e076](https://github.com/AlessioBrillo/dominus/commit/7f3e076197230c7a1d6832a3be6a19501e12f024))
* **auth:** add enterprise SSO via Auth0 OIDC ([#356](https://github.com/AlessioBrillo/dominus/issues/356)) ([f11c267](https://github.com/AlessioBrillo/dominus/commit/f11c26725a7979bba8129af78a503d2232772dc4))
* **cli:** add dominus maintenance migrate rollback and status commands ([5f860fe](https://github.com/AlessioBrillo/dominus/commit/5f860fe95052febd30c0a73b2128304075fbb7c0))
* **config:** add ADR-0078 DNS env vars (quorum, persistence, cache purge) ([#445](https://github.com/AlessioBrillo/dominus/issues/445)) ([d739fca](https://github.com/AlessioBrillo/dominus/commit/d739fca526234e6e2ec51de40f553c39b410df1b))
* **config:** add DNS_CONSENSUS_PRIVACY_FALLBACK and tertiary vote mode ([de19e5c](https://github.com/AlessioBrillo/dominus/commit/de19e5cafb22ddf80ea6cdc505ae33a8c6936868))
* **config:** add DNS_CONSENSUS_TEST_DOMAIN and VALIDATION_TIMEOUT_MS ([634f686](https://github.com/AlessioBrillo/dominus/commit/634f686469e54195b6a500ad2ca826efd01b0718))
* **consensus:** add degraded-anycast failure policy with anycast overlap threshold ([4d1c0df](https://github.com/AlessioBrillo/dominus/commit/4d1c0df0bd8bdee9fdda2f141a09aba84182b08c))
* consolidate DNS consensus ownership + watchlist parity ([#390](https://github.com/AlessioBrillo/dominus/issues/390)) ([52bb70c](https://github.com/AlessioBrillo/dominus/commit/52bb70c80f5c8365fa18e84df0bbeeaa2654037a))
* dns consensus hardening + whois resilience + watchlist consensus ([1b1ba03](https://github.com/AlessioBrillo/dominus/commit/1b1ba03a92f6fb87959513110a6d6e516e698bcc))
* **dns-consensus:** add authoritative-zone-aware disjointness validation ([#378](https://github.com/AlessioBrillo/dominus/issues/378)) ([fa341a0](https://github.com/AlessioBrillo/dominus/commit/fa341a09237177ba7592072c44de1056759bdeda))
* **dns-consensus:** harden DNS/RDAP consensus gates and closeout WHOIS cache bypass ([#366](https://github.com/AlessioBrillo/dominus/issues/366)) ([527864e](https://github.com/AlessioBrillo/dominus/commit/527864e3695d5f414858cacd17cc591772c7eb96))
* **dns-consensus:** phase 1 resilience - distinct recursors, telemetry ([#380](https://github.com/AlessioBrillo/dominus/issues/380)) ([2f41254](https://github.com/AlessioBrillo/dominus/commit/2f412545e8d320785ad48ae51bd3c2d2d144cdae))
* **dns:** add community edition fallback with NodeDnsProvider (ADR-0076) ([9417d43](https://github.com/AlessioBrillo/dominus/commit/9417d432974f571e1f088eb70a3002938303a534)), closes [#350](https://github.com/AlessioBrillo/dominus/issues/350)
* **dns:** add ConsensusEngine pure function with majority-vote tertiary ([17b8340](https://github.com/AlessioBrillo/dominus/commit/17b834057acf1596acbb1d29df7eb36277104817))
* **dns:** add controlled fallback for community edition (DNS_UNBOUND_STRICT=false) ([#434](https://github.com/AlessioBrillo/dominus/issues/434)) ([4085a5b](https://github.com/AlessioBrillo/dominus/commit/4085a5b4e1beaee3097815c03a15c26dc1b5a116))
* **dns:** add DNSSEC validation with DO=1/EDNS0 and RFC 4035 chain validation (ADR-0061) ([8e7a5e1](https://github.com/AlessioBrillo/dominus/commit/8e7a5e189245887c8693e2c5062a5209afec04df))
* **dns:** add dual-redundant secondary consensus (ADR-00XX) ([#388](https://github.com/AlessioBrillo/dominus/issues/388)) ([9ca3c00](https://github.com/AlessioBrillo/dominus/commit/9ca3c00a66fe2170876997e33a4ba80455776dc1))
* **dns:** add dual-tertiary types and config schema ([a5b0dcc](https://github.com/AlessioBrillo/dominus/commit/a5b0dccae5a56ee24eac6688c0ff39cb3e64ea59))
* **dns:** add FallbackResolver with conservative Available-blocking ([#447](https://github.com/AlessioBrillo/dominus/issues/447)) ([53f3056](https://github.com/AlessioBrillo/dominus/commit/53f30564167cab6076f46520d86b4dd5516dd894))
* **dns:** add local DoH proxy for privacy mode consensus fallback (ADR-0065) ([6e6c9a3](https://github.com/AlessioBrillo/dominus/commit/6e6c9a3c19f3afced079edf1b5c2b48f96ef037c))
* **dns:** add multi-operator resolver groups to strategy mapping ([e86f6b6](https://github.com/AlessioBrillo/dominus/commit/e86f6b6e13999bd487e2be1e4cc167d3cfbbe61b))
* **dns:** add OperatorMap module with registry loader and versioning ([#391](https://github.com/AlessioBrillo/dominus/issues/391)) ([9db5f74](https://github.com/AlessioBrillo/dominus/commit/9db5f74cf2a4e7453401c0d71a8f6888d6c15b78))
* **dns:** add per-query DNSSEC validation with @relaycorp/dnssec (ADR-0073) ([1c08392](https://github.com/AlessioBrillo/dominus/commit/1c083920a760cecdddd4f5701a568aeed37c237f))
* **dns:** add periodic DNSSEC revalidation probe to UnboundResolver ([#427](https://github.com/AlessioBrillo/dominus/issues/427)) ([a324b74](https://github.com/AlessioBrillo/dominus/commit/a324b74c163e5213828480d0360e36640c586838))
* **dns:** add runtime consensus validation strict/permissive mode (ADR-0066) ([e8e1c8a](https://github.com/AlessioBrillo/dominus/commit/e8e1c8a00e19a16d8b1d07bfe3b6c0c1daff0f66))
* **dns:** add UnboundResolver provider with DNSSEC validation (ADR-0072) ([3585ebb](https://github.com/AlessioBrillo/dominus/commit/3585ebb737a7f2cf175fe7dc0e1e32d027281ff9))
* **dns:** add UnboundResolver.healthCheck() and boot-time validation ([#415](https://github.com/AlessioBrillo/dominus/issues/415)) ([425a395](https://github.com/AlessioBrillo/dominus/commit/425a3950f4668aa9c26f7b5f26eef0a918968009))
* **dns:** add validateConsensusDisjointnessRuntime() for bootstrap validation ([921fb39](https://github.com/AlessioBrillo/dominus/commit/921fb397cb28005a825cf48d9ab2980cdb3a98a2))
* **dns:** complete Unbound single-source-of-truth migration (ADR-0072) ([07e390d](https://github.com/AlessioBrillo/dominus/commit/07e390d874df9f26dedc526a0d268289b6e1836d))
* **dns:** configure DNSSEC semantics for Unbound single-source architecture ([#428](https://github.com/AlessioBrillo/dominus/issues/428)) ([17c1e83](https://github.com/AlessioBrillo/dominus/commit/17c1e8360fdc64949a3549df76267fdadb598684))
* **dns:** consensus fallback strategy auto-switch + WHOIS/timeout race fix ([#377](https://github.com/AlessioBrillo/dominus/issues/377)) ([0b9ba0c](https://github.com/AlessioBrillo/dominus/commit/0b9ba0cf1f50de00a5745fe7215ac0b001c060d6))
* **dns:** Consensus gate resilience hardening - Priority rate limiting (ADR-0067) ([#372](https://github.com/AlessioBrillo/dominus/issues/372)) ([d028018](https://github.com/AlessioBrillo/dominus/commit/d0280184e4f51089a721a3ec5af6025c11a2b781))
* **dns:** consensus hardening + job queue priority + checkpoint tenant isolation ([0d7c0b4](https://github.com/AlessioBrillo/dominus/commit/0d7c0b49a15b355ee2663826bce0964bd986a7d4))
* **dns:** consolidate dual-redundant DNS consensus (ADR-0069) ([#398](https://github.com/AlessioBrillo/dominus/issues/398)) ([f698387](https://github.com/AlessioBrillo/dominus/commit/f6983876ef121a95f5d82e247ed957d5496d15ab))
* **dns:** deprecate 2-of-3 consensus architecture for Unbound (ADR-0072) ([#408](https://github.com/AlessioBrillo/dominus/issues/408)) ([71dd8a6](https://github.com/AlessioBrillo/dominus/commit/71dd8a69c2c0ccf940031f617433089d907d8fca))
* **dns:** DNS Resolver Resilience Hardening — Quorum, DNSSEC State Persistence, Cache Purge (ADR-0078) ([#444](https://github.com/AlessioBrillo/dominus/issues/444)) ([899e049](https://github.com/AlessioBrillo/dominus/commit/899e049628a4438ba6a34e99d1e449af483ddb2b))
* **dns:** DNS SLO observability + doh-alternate tertiary in prod override ([#359](https://github.com/AlessioBrillo/dominus/issues/359)) ([eb3f898](https://github.com/AlessioBrillo/dominus/commit/eb3f89886f7cf04b8072554c7d837b80a4fc0f6c))
* **dns:** DNSSEC validation (ADR-0061) ([#367](https://github.com/AlessioBrillo/dominus/issues/367)) ([e5e54f9](https://github.com/AlessioBrillo/dominus/commit/e5e54f99e23fc7f1aa45d73f2c949eccc664f56f))
* **dns:** dual-redundant tertiary in production override (ADR-0068) ([8897956](https://github.com/AlessioBrillo/dominus/commit/8897956cdbf00f3eca1cb304e564869b615d9fd2))
* **dns:** enable DNS_PRIVACY_MODE by default for community edition (ADR-0065) ([39ae824](https://github.com/AlessioBrillo/dominus/commit/39ae82423d87895715b096630d7a0e2cd8ccb488))
* **dns:** enforce consensus topology validation at provider factory boot ([522be04](https://github.com/AlessioBrillo/dominus/commit/522be04d912ff09ed19a57cecbb9bed9010fc298))
* **dns:** enforce Unbound multi-host quorum (Step 1 hardening) ([#436](https://github.com/AlessioBrillo/dominus/issues/436)) ([37cc4ae](https://github.com/AlessioBrillo/dominus/commit/37cc4aeddcb2db9fa4bea60d6d340c085d5a31d8))
* **dns:** extend resolveEndpointsLive with full anycast IP resolution (A + AAAA) ([eaec771](https://github.com/AlessioBrillo/dominus/commit/eaec771fd3469da9f89f0b6349521c0d6df38376))
* **dns:** harden consensus revalidation with strict anycast overlap veto and metrics (ADR-0072) ([#407](https://github.com/AlessioBrillo/dominus/issues/407)) ([1f9d625](https://github.com/AlessioBrillo/dominus/commit/1f9d625886b6e617eea00d923b613d7383ed7039))
* **dns:** harden DNS consensus with privacy, tertiary redundancy and observability ([#360](https://github.com/AlessioBrillo/dominus/issues/360)) ([ef408a0](https://github.com/AlessioBrillo/dominus/commit/ef408a0627ef1c17b26a1f4c988c9e5e124778c3))
* **dns:** harden tertiary consensus leg for fault tolerance (ADR-0066) ([973c13c](https://github.com/AlessioBrillo/dominus/commit/973c13cb2d226b7d86ac0fc6098211daf1df6b7a))
* **dns:** harden Unbound resolver readiness with DNSSEC validation proof and socket pre-check ([#437](https://github.com/AlessioBrillo/dominus/issues/437)) ([fac7aa9](https://github.com/AlessioBrillo/dominus/commit/fac7aa9e43bf54bd478ea0015f076f4930f0e064))
* **dns:** implement ConsensusDnsProvider abstraction for 2-of-3/2-of-2+1 DNS consensus ([76d1c5b](https://github.com/AlessioBrillo/dominus/commit/76d1c5b5be08d301481b89f079e76dcef43d238f))
* **dns:** implement dual-tertiary rescue/veto logic in ConsensusDnsProvider ([5b47078](https://github.com/AlessioBrillo/dominus/commit/5b47078ef73a76f5b45775a84faeaf493853da66))
* **dns:** implement local-doh fallback for privacy mode consensus (ADR-0065) ([471887a](https://github.com/AlessioBrillo/dominus/commit/471887a680409f080997ba5ff8e653d74ab88c81))
* **dns:** make Unbound resolver mandatory for all editions (ADR-0075) ([#438](https://github.com/AlessioBrillo/dominus/issues/438)) ([cd1e6eb](https://github.com/AlessioBrillo/dominus/commit/cd1e6eb0b5f5770185c21a4616db141561071023))
* **dns:** make UnboundResolver single DnsProvider; remove NodeDnsProvider fallback ([9ca9866](https://github.com/AlessioBrillo/dominus/commit/9ca9866f17837fb97e97762aee674d369f5894b2))
* **dns:** migrate to Unbound single source of truth (ADR-0072) ([#409](https://github.com/AlessioBrillo/dominus/issues/409)) ([73de25c](https://github.com/AlessioBrillo/dominus/commit/73de25cd1baccea1e87d769fdfb4ebcfc3fc27f3))
* **dns:** multi-host failover & quorum enforcement for UnboundResolver ([#435](https://github.com/AlessioBrillo/dominus/issues/435)) ([2dd99aa](https://github.com/AlessioBrillo/dominus/commit/2dd99aaad4b8025e16c858e8a434702ca2307500))
* **dns:** multi-host Unbound resolver pool with round-robin selection ([2576f15](https://github.com/AlessioBrillo/dominus/commit/2576f15634b7537e7c30b42dc600e1229d00b73c))
* **dns:** privacy-mode consensus fallback (degraded + local-doh) ([a3302a6](https://github.com/AlessioBrillo/dominus/commit/a3302a6e85ed0b7001f59e1a94c660c9360a30d1))
* **dns:** require DNS_CONSENSUS_NAMESERVERS when privacy mode + consensus enabled ([#373](https://github.com/AlessioBrillo/dominus/issues/373)) ([004598b](https://github.com/AlessioBrillo/dominus/commit/004598bc0d77731bde63a5d473959dbbc93632b9))
* **dns:** require DNSSEC validation for Available verdicts in DnsPreFilterStage ([66ec6db](https://github.com/AlessioBrillo/dominus/commit/66ec6db7f2db9c74154ca3641f19d5a28d1b8667))
* **dns:** runtime consensus disjointness validation (ADR-0066) ([174e9ae](https://github.com/AlessioBrillo/dominus/commit/174e9ae2020acf175e8fa28afbd7af3372c93739))
* **dns:** runtime disjointness re-validation for 2-of-3 consensus (ADR-0063/0066) ([#386](https://github.com/AlessioBrillo/dominus/issues/386)) ([99eccc4](https://github.com/AlessioBrillo/dominus/commit/99eccc4be7042d226ea5a48a26e0bcb8f636d62b))
* **dns:** switch consensus default to doh-alternate (port 443) and enable tertiary ([0c65fc1](https://github.com/AlessioBrillo/dominus/commit/0c65fc10ec90102b97801dc72e55726b7d7b5af9))
* **dns:** Unbound fallback & DNSSEC continuous validation ([#433](https://github.com/AlessioBrillo/dominus/issues/433)) ([26ac9c9](https://github.com/AlessioBrillo/dominus/commit/26ac9c9a9586f64c999ffae43e9e9eb950f1b601))
* **dns:** Unbound quorum hardening + fail-closed RDAP consensus ([#446](https://github.com/AlessioBrillo/dominus/issues/446)) ([7b7cd64](https://github.com/AlessioBrillo/dominus/commit/7b7cd6444a815d4fe17f3fecb7d89e8370c51151))
* **dns:** validate DNSSEC in Unbound health check and expose dnssec status in resolution ([6b7ac8c](https://github.com/AlessioBrillo/dominus/commit/6b7ac8ceef13c6826b31269dfd4b14029c37df7f))
* **dns:** wire DnsMonitor and apply adaptive load shedding ([9deccc7](https://github.com/AlessioBrillo/dominus/commit/9deccc7cbef7f3ba4cab77ae9978032fa023f9f4))
* **dns:** wire dual-tertiary providers in buildDnsConsensusConfig ([8efcd65](https://github.com/AlessioBrillo/dominus/commit/8efcd65376f26e5911f985623cc341b8afb1f8a8))
* **enterprise:** custom pricing with amount cross-check (closes audit finding) ([#376](https://github.com/AlessioBrillo/dominus/issues/376)) ([c71f006](https://github.com/AlessioBrillo/dominus/commit/c71f006b90e2e28a0f4c95150af4d3b5b498f43c))
* **infra:** harden SSH ingress, enforce Postgres TLS, fail fast on weak compose defaults ([#346](https://github.com/AlessioBrillo/dominus/issues/346)) ([e8b18f6](https://github.com/AlessioBrillo/dominus/commit/e8b18f6fdd195807c8a3ea6be13f778bfd11c920))
* **lock:** add fenced advisory lock with split-brain prevention ([3b40b35](https://github.com/AlessioBrillo/dominus/commit/3b40b358964dcd565a89b5ac5c2eae6592c86707))
* **lock:** add fenced advisory lock with split-brain prevention ([0190b04](https://github.com/AlessioBrillo/dominus/commit/0190b047ac920b1b7b27c6238dcda9f9914d38f5))
* **lock:** shard pipeline advisory lock per-stage ([1b6581e](https://github.com/AlessioBrillo/dominus/commit/1b6581ed2a89fa9f86f450e70178d2293b06b88f))
* **metrics:** add USPTO WAF block rate observability for Prometheus alerting ([#365](https://github.com/AlessioBrillo/dominus/issues/365)) ([f78982e](https://github.com/AlessioBrillo/dominus/commit/f78982ed2fb283abc3bc62d14355e406b55f3958))
* **migration:** add manifest v2 with content hashes and verify-roundtrip script ([e551d68](https://github.com/AlessioBrillo/dominus/commit/e551d68b0b03a387e7e2cd5dc62a963659b0e7da))
* **migration:** add rollbackMigration with advisory lock and LIFO enforcement ([08b1ef1](https://github.com/AlessioBrillo/dominus/commit/08b1ef1bd0a9174b630c0f53fdb7a9af06a59305))
* **obs:** add Unbound resolver metrics (ADR-0072) ([232ad84](https://github.com/AlessioBrillo/dominus/commit/232ad848a4feb8269da6615e65e02f149fdc0a8c))
* **observability:** add DNS tertiary SPOF and disjointness alerts ([f62f6e8](https://github.com/AlessioBrillo/dominus/commit/f62f6e83eb66659bed128278f0d132946cd7ae02))
* **pipeline:** add checkpoint schema versioning and validation ([a1a93e7](https://github.com/AlessioBrillo/dominus/commit/a1a93e7e03bb102738159b939e4f085308847b7b))
* **pipeline:** persist VerdictProvenance for DNS and RDAP ([#419](https://github.com/AlessioBrillo/dominus/issues/419)) ([1bdba4c](https://github.com/AlessioBrillo/dominus/commit/1bdba4c2f4ca5d12d27602f444c12b30b8b24069)), closes [#417](https://github.com/AlessioBrillo/dominus/issues/417) [#418](https://github.com/AlessioBrillo/dominus/issues/418) [#416](https://github.com/AlessioBrillo/dominus/issues/416)
* **pipeline:** phase 4 - pipeline resilience hardening ([a9b480b](https://github.com/AlessioBrillo/dominus/commit/a9b480bfd1289b065fa2b85752dd43266253acd6))
* **provider/listing:** add Afternic marketplace provider ([#399](https://github.com/AlessioBrillo/dominus/issues/399)) ([cb57c64](https://github.com/AlessioBrillo/dominus/commit/cb57c64c1e6db10d0dbf0f89efe760ddd3555509))
* **provider/listing:** add Sedo marketplace provider ([#406](https://github.com/AlessioBrillo/dominus/issues/406)) ([94a5090](https://github.com/AlessioBrillo/dominus/commit/94a5090235a9c92639be41e94ef10a840d0df6b2))
* **rdap-consensus:** add static disjointness validation at bootstrap ([ab9f986](https://github.com/AlessioBrillo/dominus/commit/ab9f986b9e4b90e93929490eb82c57f8fed89b87))
* **rdap:** add consensus probe retry/backoff and fail-open (ADR-0074) ([4feea63](https://github.com/AlessioBrillo/dominus/commit/4feea63128a11b6bd73eb4b03aaf84858cdc546c))
* **rdap:** add per-TLD WHOIS rescue override for consensus gate ([#363](https://github.com/AlessioBrillo/dominus/issues/363)) ([173ce09](https://github.com/AlessioBrillo/dominus/commit/173ce09b8a2e9b83b55eae7d8572b8621269c6d5))
* **rdap:** add tertiary leg config types and validation ([#364](https://github.com/AlessioBrillo/dominus/issues/364)) ([df16468](https://github.com/AlessioBrillo/dominus/commit/df16468a4b9c73e62898af85e0cde84974bd5ca9))
* **rdap:** enable WHOIS rescue by default for problematic ccTLDs (ADR-0051) ([bc548ae](https://github.com/AlessioBrillo/dominus/commit/bc548ae7e2edb44dd4e713fdf7cc9621517de08c))
* **rdap:** implement per-TLD authoritative secondary consensus leg (ADR-0077) ([01d3dcf](https://github.com/AlessioBrillo/dominus/commit/01d3dcfce840962ad483e56136f289646712c5f1))
* **rdap:** implement tertiary consensus leg + dedicated WHOIS rescue budget ([80867be](https://github.com/AlessioBrillo/dominus/commit/80867bea438539ce8332ab3691269ac4e61ea297))
* **release:** migrate-before-roll with dedicated timeout (ADR-0061) + DNS fail-closed hardening ([#355](https://github.com/AlessioBrillo/dominus/issues/355)) ([7833a72](https://github.com/AlessioBrillo/dominus/commit/7833a723915a2f2f2c311877ca6cb4445279b23a))
* **scoring:** add commercial signal observability with degradation emission ([e3e6573](https://github.com/AlessioBrillo/dominus/commit/e3e657328e71458cdd703990808499828cc78166))
* **types:** add VerdictProvenance chain for DNS/RDAP/Trademark audit trail ([df23fef](https://github.com/AlessioBrillo/dominus/commit/df23fef81a8ff81662acff799d7a6dfdb4efb863))
* v1.1.0 release hardening (tenant isolation, operator role, invitations, PG parity, a11y) ([#461](https://github.com/AlessioBrillo/dominus/issues/461)) ([2c11495](https://github.com/AlessioBrillo/dominus/commit/2c11495d0c7f506c764d848d16cb44fc1022c6b6))


### Bug Fixes

* **api:** await async list() in GET /api/v1/watchlist ([#354](https://github.com/AlessioBrillo/dominus/issues/354)) ([3074566](https://github.com/AlessioBrillo/dominus/commit/30745661e73709739931cc13a38262b4249adb5e))
* **auth:** implement OidcProvider interface properly ([03b1726](https://github.com/AlessioBrillo/dominus/commit/03b17265730b5e42d0a99286adf550c9a34903c9))
* **build:** ship a complete npm artifact and a single SPA layout ([919af28](https://github.com/AlessioBrillo/dominus/commit/919af28602d3f93153377b9a013b8cf1f2aecd75))
* **ci:** boot CI and the default compose stack without Unbound ([#424](https://github.com/AlessioBrillo/dominus/issues/424)) ([eac810a](https://github.com/AlessioBrillo/dominus/commit/eac810a99039b71d2d877f9cd21510f1db193941)), closes [#417](https://github.com/AlessioBrillo/dominus/issues/417)
* **cli:** report the real version in the published package ([02a3e39](https://github.com/AlessioBrillo/dominus/commit/02a3e39ebdff447cf3f74da5058ca661cacba04a))
* **config:** DNS fallback, quorum, RDAP probe fail-open for community edition (ADR-0076/0077/0078) ([#448](https://github.com/AlessioBrillo/dominus/issues/448)) ([1e00cd2](https://github.com/AlessioBrillo/dominus/commit/1e00cd2814fad3506b114f0f32c634613008d929))
* **config:** enforce Redis in cloud mode with explicit split-brain warning ([#393](https://github.com/AlessioBrillo/dominus/issues/393)) ([dd92871](https://github.com/AlessioBrillo/dominus/commit/dd9287179c97bc4ba89c30f5b77e698a2d6300b1))
* **config:** sync DNS_CONSENSUS_STRATEGY enum with supported resolver strategies ([ff0b43b](https://github.com/AlessioBrillo/dominus/commit/ff0b43b116d1369666e46a2cd5d77103d3593455))
* **db:** add file-based advisory lock for SQLite cross-process safety ([#392](https://github.com/AlessioBrillo/dominus/issues/392)) ([d2a7df3](https://github.com/AlessioBrillo/dominus/commit/d2a7df3e90952dc2e06d3994a2f36fbb994772a8))
* **db:** single write provider with explicit lifecycle (ADR-0080) ([#451](https://github.com/AlessioBrillo/dominus/issues/451)) ([73a9244](https://github.com/AlessioBrillo/dominus/commit/73a9244dbe0e234acfe4aeff7cb3e7deaa1fdaf3))
* **deploy:** honor context-aware DNS strict default (ADR-0076) ([#452](https://github.com/AlessioBrillo/dominus/issues/452)) ([a108377](https://github.com/AlessioBrillo/dominus/commit/a108377ec22c9e3eb8f2203f47f89830a17a080c))
* **deps:** resolve critical and high security vulnerabilities via audit fix ([c806452](https://github.com/AlessioBrillo/dominus/commit/c806452e93228d313490c77e835ee3a33b347873))
* **dns-consensus:** veto consensus gate when primary fallback shares recursor (single-recursor mode) ([#379](https://github.com/AlessioBrillo/dominus/issues/379)) ([7d4531c](https://github.com/AlessioBrillo/dominus/commit/7d4531ca249fc4008914c26e45a3521d03011b3e))
* **dns:** add consensus gate observability and configurable degrade-on-failure mode ([d962552](https://github.com/AlessioBrillo/dominus/commit/d962552dc1978cba9d1ab9e411fedc85f62be943))
* **dns:** allow single-recursor mode in fallback isolation with degraded consensus ([#375](https://github.com/AlessioBrillo/dominus/issues/375)) ([0c813ff](https://github.com/AlessioBrillo/dominus/commit/0c813ff31764bb899f2ebd0a3748488c6e9a8911))
* **dns:** auto-degrade consensus gate on runtime anycast overlap detection ([#394](https://github.com/AlessioBrillo/dominus/issues/394)) ([f64cbcc](https://github.com/AlessioBrillo/dominus/commit/f64cbcc8675a41eacb24182f4e7931a26c1f1005))
* **dns:** consensus hardening phase 1 ([e08b5e1](https://github.com/AlessioBrillo/dominus/commit/e08b5e13523988a36ea4490313a0d256f231b0a6))
* **dns:** DNS consensus independence hardening (P0-P3) ([#358](https://github.com/AlessioBrillo/dominus/issues/358)) ([d259555](https://github.com/AlessioBrillo/dominus/commit/d25955548b9e55818798a7b1528a8e880230d0ac))
* **dns:** eliminate silent consensus disable - hard fail at runtime ([db24d72](https://github.com/AlessioBrillo/dominus/commit/db24d72b86fddb55880d35d02d4f5617fd6736ba))
* **dns:** ensure disabled=false in enabled consensus config ([91c55ca](https://github.com/AlessioBrillo/dominus/commit/91c55cac3f930c7dbd25ec87e52ee43c2f149542))
* **dns:** extend ConsensusEngineOptions with secondaryProviders array for dual-redundant consensus ([#397](https://github.com/AlessioBrillo/dominus/issues/397)) ([72b2b97](https://github.com/AlessioBrillo/dominus/commit/72b2b97a4e27cae9c617747623368175c0fc5161))
* **dns:** fallback isolation validation for 2-of-3 consensus gate (ADR-0063 P0) ([6efed36](https://github.com/AlessioBrillo/dominus/commit/6efed368e4981c8f7914e2ad120b28aa5c17236d))
* **dns:** handle undefined return from checkBulk in DnsPreFilterStage ([2b79f79](https://github.com/AlessioBrillo/dominus/commit/2b79f79e2a57197ba1187f5389554719f5178503))
* **dns:** implement adaptive timeout and DNSSEC validation caching (ADR-0079, ADR-0076) ([9ec73fb](https://github.com/AlessioBrillo/dominus/commit/9ec73fbec27d3b681ccc4881b650163bafc6c459))
* **dns:** include DoH format in circuit breaker key ([8b1857a](https://github.com/AlessioBrillo/dominus/commit/8b1857af1dae6ddcda27889fc304ffaec5761575))
* **dns:** persist circuit breaker state across restarts via provider_cache ([#396](https://github.com/AlessioBrillo/dominus/issues/396)) ([74ab9dd](https://github.com/AlessioBrillo/dominus/commit/74ab9dd1af383feecab7a5da94c5cc78f5a048d3))
* **dns:** pin native resolver leg to private recursor, rigorous DNSSEC ([#350](https://github.com/AlessioBrillo/dominus/issues/350)) ([3d7f64b](https://github.com/AlessioBrillo/dominus/commit/3d7f64b25b25a67a1c05d45d98183aa4168161e3))
* **dns:** prove DNSSEC validation with a negative control instead of the unsupported DS probe ([#416](https://github.com/AlessioBrillo/dominus/issues/416)) ([1b3914c](https://github.com/AlessioBrillo/dominus/commit/1b3914cd411a269f29d82fc0f376cfe5f432504a))
* **dns:** restore native resolver fallback when Unbound is disabled ([#421](https://github.com/AlessioBrillo/dominus/issues/421)) ([99b9502](https://github.com/AlessioBrillo/dominus/commit/99b95026baf75efae902b4cc07b7117f8a983fb5)), closes [#417](https://github.com/AlessioBrillo/dominus/issues/417)
* **dns:** use pinned resolvers for consensus runtime re-validation ([#387](https://github.com/AlessioBrillo/dominus/issues/387)) ([dc301ba](https://github.com/AlessioBrillo/dominus/commit/dc301ba41793f7026e7d920fa8a5e60398407276))
* **docker:** remove fabricated unbound-exporter image reference ([#420](https://github.com/AlessioBrillo/dominus/issues/420)) ([7c14e82](https://github.com/AlessioBrillo/dominus/commit/7c14e82cc05b93d4eaabc0cef491bc2a462cf7d3)), closes [#418](https://github.com/AlessioBrillo/dominus/issues/418)
* enforce strict DNS consensus + WHOIS rescue budget + tertiary budget isolation ([4918645](https://github.com/AlessioBrillo/dominus/commit/4918645d4ae3b35ba32922c5834eec7a015b1190))
* flaky job dequeue on Windows and zlib CVE in the runtime images ([#466](https://github.com/AlessioBrillo/dominus/issues/466)) ([43f9ac0](https://github.com/AlessioBrillo/dominus/commit/43f9ac0ccef920a4e4ac33081ebee2fc83e47856))
* **listing:** close trademark gate bypass and remote id confusion ([#400](https://github.com/AlessioBrillo/dominus/issues/400)) ([9690f74](https://github.com/AlessioBrillo/dominus/commit/9690f74b7855105111add60182722c61955a8528))
* **migrations:** add backwardCompatible to all migrations for release gate compliance ([294118f](https://github.com/AlessioBrillo/dominus/commit/294118f09546bc74e4eff911090e7ebfd36a717a))
* **ops:** make the documented quick-start actually complete ([e947eba](https://github.com/AlessioBrillo/dominus/commit/e947eba25c6f0671dc3ebf99894b878513dc3b77))
* **pipeline:** derive persistence deadline from lock TTL/heartbeat config ([#395](https://github.com/AlessioBrillo/dominus/issues/395)) ([f7a7824](https://github.com/AlessioBrillo/dominus/commit/f7a782448e3b3828d2e3e8f42281911c5dd49e16))
* **provider/dns:** fallback fail-closed hardening (ADR-0079) ([#449](https://github.com/AlessioBrillo/dominus/issues/449)) ([a166a4c](https://github.com/AlessioBrillo/dominus/commit/a166a4cfea9887e61cbe06a41e3db18728419065))
* **providers:** harden RDAP redirects/body cap and cancel orphaned DNS lookups ([#347](https://github.com/AlessioBrillo/dominus/issues/347)) ([f4b0197](https://github.com/AlessioBrillo/dominus/commit/f4b0197f8288fe04a3fcc7b740b5d902c09ed8a8))
* **publish:** make the npm artifact work from a clean clone ([7a91a17](https://github.com/AlessioBrillo/dominus/commit/7a91a17d9c8377cd1c55063f23f40c76d5a61a0e))
* **rdap,config,provider:** bootstrap routing, boolean env coercion, cache prune ([#353](https://github.com/AlessioBrillo/dominus/issues/353)) ([8f5bb10](https://github.com/AlessioBrillo/dominus/commit/8f5bb105a5a90d02710675443988362979254350))
* **rdap,dns:** never combine Node global fetch with an undici v8 dispatcher ([#352](https://github.com/AlessioBrillo/dominus/issues/352)) ([c53c5c9](https://github.com/AlessioBrillo/dominus/commit/c53c5c99c8631eba0303723340aa02164a083bb1))
* rls migration uses direct coalesce in policy for pg safety ([493ccfa](https://github.com/AlessioBrillo/dominus/commit/493ccfa1a8ecbf678d2cbcb81301c6a07a8fc6bb))
* rls migration uses plpgsql with exception handling for pg safety ([4ea643b](https://github.com/AlessioBrillo/dominus/commit/4ea643b5e3b0bfd83b332269045584832c97ec67))
* **scoring:** modulate market anchor by dataDensity (ADR-0002) ([#362](https://github.com/AlessioBrillo/dominus/issues/362)) ([0a24fac](https://github.com/AlessioBrillo/dominus/commit/0a24fac585cc198398a69756857e06ae65225e13))
* **security:** patch libssl3/libcrypto3 CVEs and bump qs/js-yaml/fast-uri ([#423](https://github.com/AlessioBrillo/dominus/issues/423)) ([1721e47](https://github.com/AlessioBrillo/dominus/commit/1721e47ba8e18746d0eaaa5d47f147922f82f67f))
* set app.tenant_id GUC in PG before migrations for CI ([0259826](https://github.com/AlessioBrillo/dominus/commit/0259826ba7bd7c047fe8a702775b294e0280e45f))
* short-circuit Unknown candidates before scoring stage ([b717d62](https://github.com/AlessioBrillo/dominus/commit/b717d626fbc9ed720c05c0ce057966c1e1108ca4))
* skip RLS migration in CI for migration roundtrip test ([e71ebd6](https://github.com/AlessioBrillo/dominus/commit/e71ebd65a6de54d05289d081012c9a7942c1babb))
* **test:** admin usage test - use ISO date regex instead of hardcoded month ([b4df6ef](https://github.com/AlessioBrillo/dominus/commit/b4df6efd8b92174c3ff4498af950873e5cd08fd2))
* **test:** update provider-factory test for new default consensus strategy ([7d177bb](https://github.com/AlessioBrillo/dominus/commit/7d177bb1cbc5106d0551b1cce578fb4e72b5b579))
* **test:** update provider-factory tests for doh-primary primary strategy ([e5c8684](https://github.com/AlessioBrillo/dominus/commit/e5c8684a7466144486f65e41266944814d660b12))
* **trademark:** harden USPTO WAF resilience ([1276d53](https://github.com/AlessioBrillo/dominus/commit/1276d536b28f9ba87d9e128314407124c381d6b3))
* **trademark:** make the EUIPO gate fail-closed instead of silently truncating ([5eb4646](https://github.com/AlessioBrillo/dominus/commit/5eb4646d8ebc36ca7136ee61d1a2a63233825bf0))
* use file flag to skip RLS migration in CI ([e76930e](https://github.com/AlessioBrillo/dominus/commit/e76930e018daab612ad4b738a3c108318663b471))


### Performance Improvements

* **frontend:** split the bundle instead of shipping one 1 MB chunk ([135495a](https://github.com/AlessioBrillo/dominus/commit/135495ad5e54fcc9925eac11894e6130eeedb59b))


* **dns:** remove NodeDnsProvider per ADR-0075 single source of truth ([ca8b6d9](https://github.com/AlessioBrillo/dominus/commit/ca8b6d916eb848e203a7fbc9108e582892153546))


### Documentation

* add a documentation drift gate and correct the drifted documents ([0b28921](https://github.com/AlessioBrillo/dominus/commit/0b2892104f0d5fd97d6013661660332ee8c76d8c))
* add enterprise-tier.md status report ([#460](https://github.com/AlessioBrillo/dominus/issues/460)) ([88ca00a](https://github.com/AlessioBrillo/dominus/commit/88ca00a89ef0633efeb29352d0bc6e2c6b683143))
* **adr:** add ADR-0080 db connection topology ([#450](https://github.com/AlessioBrillo/dominus/issues/450)) ([8c695b1](https://github.com/AlessioBrillo/dominus/commit/8c695b1c60fbb12e22938b2544c1d75b953c9f37))
* **adr:** ADR-0068 DNS tertiary dual-redundancy for SPOF elimination ([19ab596](https://github.com/AlessioBrillo/dominus/commit/19ab596aaea349cd9f5370b741dab21642d34c8b))
* **governance:** finish the launch-facing commitments ([bb5fec1](https://github.com/AlessioBrillo/dominus/commit/bb5fec1e2ddc3e749a296bd72039322656f620d2))

## [1.0.0](https://github.com/AlessioBrillo/dominus/compare/v0.11.0...v1.0.0) (2026-08-17)


### Features

* **admin:** platform admin overview API + frontend page ([#279](https://github.com/AlessioBrillo/dominus/issues/279)) ([7405e5f](https://github.com/AlessioBrillo/dominus/commit/7405e5f1d3bf6fe9e8ae41668f6b07fb0d6c2999))
* **admin:** tenant lifecycle management (ADR-0057) ([#292](https://github.com/AlessioBrillo/dominus/issues/292)) ([36ae58e](https://github.com/AlessioBrillo/dominus/commit/36ae58e3097dc3c5adf7fbb272791be9bb4e3ce3))
* **backup:** point-in-time recovery for the Cloud stack (ADR-0054) ([#282](https://github.com/AlessioBrillo/dominus/issues/282)) ([9162353](https://github.com/AlessioBrillo/dominus/commit/916235347d12613a18bc73c0c758522934610499))
* **billing:** complete the billing loop — Team checkout, status-aware enforcement, trial-once (ADR-0053) ([#281](https://github.com/AlessioBrillo/dominus/issues/281)) ([271f61a](https://github.com/AlessioBrillo/dominus/commit/271f61a0040e66f531cc7d27821d0e86586652f4)), closes [#280](https://github.com/AlessioBrillo/dominus/issues/280)
* **cli:** add admin API key bootstrap command ([#322](https://github.com/AlessioBrillo/dominus/issues/322)) ([7fbbad2](https://github.com/AlessioBrillo/dominus/commit/7fbbad2dca507392631ef5f619b029504f82cd80))
* **cloud:** add self-serve signup with one-time admin key ([#324](https://github.com/AlessioBrillo/dominus/issues/324)) ([68ad109](https://github.com/AlessioBrillo/dominus/commit/68ad10905ac52bb1e6ce8620c23bb9741af49317))
* **cloud:** add team management page ([#325](https://github.com/AlessioBrillo/dominus/issues/325)) ([4e84fdc](https://github.com/AlessioBrillo/dominus/commit/4e84fdc8b72a1833317344552c59b0643ff93386))
* **cloud:** enforce plan seat limits at API key mint ([#323](https://github.com/AlessioBrillo/dominus/issues/323)) ([88f053f](https://github.com/AlessioBrillo/dominus/commit/88f053f1c15cb5493d7814ae3e98247719323097))
* **db:** add composite tenant_id+domain indexes (B2) ([#275](https://github.com/AlessioBrillo/dominus/issues/275)) ([4a385d9](https://github.com/AlessioBrillo/dominus/commit/4a385d99565decc3ced208029007f3b89bc46f02))
* **dns:** circuit breakers, strict 2-of-3 consensus, bundled parking list (ADR-0059) ([#331](https://github.com/AlessioBrillo/dominus/issues/331)) ([2b7dd51](https://github.com/AlessioBrillo/dominus/commit/2b7dd51fc8f60a2c821ff311c18f39f9e53b4abc))
* **http:** explicit keep-alive/header/request socket timeouts (B5) ([#278](https://github.com/AlessioBrillo/dominus/issues/278)) ([42c1067](https://github.com/AlessioBrillo/dominus/commit/42c10676985a3cd4cfceab3228d474194da38051))
* **infra:** compress rotated container logs (B3) ([#276](https://github.com/AlessioBrillo/dominus/issues/276)) ([5677c02](https://github.com/AlessioBrillo/dominus/commit/5677c0232947925829526176b2c4c592a05c85c7))
* **infra:** hetzner terraform provisioning for the cloud mvp ([#306](https://github.com/AlessioBrillo/dominus/issues/306)) ([ffea2ed](https://github.com/AlessioBrillo/dominus/commit/ffea2ed3e4483fd4ff64a50879960faa64d899ed))
* **infra:** turnkey DNS consensus recursor override ([#305](https://github.com/AlessioBrillo/dominus/issues/305)) ([98e037e](https://github.com/AlessioBrillo/dominus/commit/98e037ee4ac0ef73fd5b660facbf83a339dbc8c8))
* isolate anonymous trademark budget for public valuations ([#285](https://github.com/AlessioBrillo/dominus/issues/285)) ([7db9f98](https://github.com/AlessioBrillo/dominus/commit/7db9f98d6977c46f008af6f86f856bb329a88ea8))
* **rdap:** gate parity — consensus default-on, resilient bootstrap, origin-overlap guard (ADR-0058) ([#293](https://github.com/AlessioBrillo/dominus/issues/293)) ([4f4f41f](https://github.com/AlessioBrillo/dominus/commit/4f4f41f6ff5d6e4b4a0b3468508fced349a83bf6))
* **redis:** volatile-lru eviction + redis-exporter + eviction alerts (B1) ([#274](https://github.com/AlessioBrillo/dominus/issues/274)) ([d7f9b45](https://github.com/AlessioBrillo/dominus/commit/d7f9b459d7c3447877928922b3a6a9fea7872d06))
* **scheduler:** dedupe cron fires across replicas via per-slot lock (B4) ([#277](https://github.com/AlessioBrillo/dominus/issues/277)) ([06c6b1f](https://github.com/AlessioBrillo/dominus/commit/06c6b1f69cd7f0850ccdf2a5daa88bbd0266a873))
* **team:** add Team plan tier and team seats management ([#280](https://github.com/AlessioBrillo/dominus/issues/280)) ([066df82](https://github.com/AlessioBrillo/dominus/commit/066df82cc74a3d41dd441b9ad27f4dc5d59a57ab))
* trademark gate observability — bounded provider deadline, gate telemetry, lock renewal tracking ([#284](https://github.com/AlessioBrillo/dominus/issues/284)) ([0cfbc09](https://github.com/AlessioBrillo/dominus/commit/0cfbc09a7e3face4d6c448161190be934aaeb4dc))
* **usage:** usage history API, usage-only prune, Usage page ([#287](https://github.com/AlessioBrillo/dominus/issues/287)) ([26612f9](https://github.com/AlessioBrillo/dominus/commit/26612f93bb9b0ab77ded12e59d6fd49094fe560d))


### Bug Fixes

* **backup:** prune archived WAL segments on base-backup run ([#333](https://github.com/AlessioBrillo/dominus/issues/333)) ([02956fb](https://github.com/AlessioBrillo/dominus/commit/02956fba04e7f250dfa3097672dd8aa504e7b083))
* **backups:** persist pg_dump backups on dedicated volume in base compose and cloud render ([#341](https://github.com/AlessioBrillo/dominus/issues/341)) ([889afe5](https://github.com/AlessioBrillo/dominus/commit/889afe5f08c112925ce30454f1048d22c58b5a2b))
* **billing:** status-aware team seats, unlimited enterprise, ADR-0026 pricing ([#286](https://github.com/AlessioBrillo/dominus/issues/286)) ([8a62730](https://github.com/AlessioBrillo/dominus/commit/8a627304a041a5a91eaa93625523b62af6545e74))
* **cloud:** fail-closed usage enforcement in cloud mode ([#318](https://github.com/AlessioBrillo/dominus/issues/318)) ([62929eb](https://github.com/AlessioBrillo/dominus/commit/62929eba2183ee4ae4ad41bdd2ec8917292a98fb))
* **deps:** revert breaking dependabot major bumps ([#309](https://github.com/AlessioBrillo/dominus/issues/309)) ([8c2ea2b](https://github.com/AlessioBrillo/dominus/commit/8c2ea2b38b8763c7880d2f1a53de88b536a80e6a)), closes [#300](https://github.com/AlessioBrillo/dominus/issues/300) [#301](https://github.com/AlessioBrillo/dominus/issues/301) [#303](https://github.com/AlessioBrillo/dominus/issues/303)
* **infra:** connect the app as the rls-scoped dominus_app role ([#317](https://github.com/AlessioBrillo/dominus/issues/317)) ([e8d4713](https://github.com/AlessioBrillo/dominus/commit/e8d47139a01bc757c143dca24bd46599e284cf91))
* **infra:** enable PITR on the cloud db node ([#316](https://github.com/AlessioBrillo/dominus/issues/316)) ([517d933](https://github.com/AlessioBrillo/dominus/commit/517d933abe59ee67798d8abac9d3d5c0eee5f1a1))
* **infra:** make the cloud deploy pipeline actually deploy ([#327](https://github.com/AlessioBrillo/dominus/issues/327)) ([cd5b153](https://github.com/AlessioBrillo/dominus/commit/cd5b153a1892490815a212402456c34ec2076a92))
* **infra:** require off-host b2 backups by default ([#328](https://github.com/AlessioBrillo/dominus/issues/328)) ([f8cac6f](https://github.com/AlessioBrillo/dominus/commit/f8cac6f6168bd54433d4ed1368821f5fd6c2b921))
* **pipeline:** harden checkpoint resume and heartbeat tenant scoping ([#283](https://github.com/AlessioBrillo/dominus/issues/283)) ([459bb88](https://github.com/AlessioBrillo/dominus/commit/459bb88ef14d2c1c8f77a2f11864041b541bcf2c))
* **pitr:** record base-backup manifest in pitr_health table ([#342](https://github.com/AlessioBrillo/dominus/issues/342)) ([4fe1df5](https://github.com/AlessioBrillo/dominus/commit/4fe1df5b031a380aecde28c17de0468a73d12202))
* **provider/rdap:** veto same-origin consensus rubber stamp ([#329](https://github.com/AlessioBrillo/dominus/issues/329)) ([5a62ac3](https://github.com/AlessioBrillo/dominus/commit/5a62ac3bd1018e327ea4ea3e5c4465f62a7e7454))
* **rdap:** fail closed when the origin guard resolver fails (ADR-0060) ([#344](https://github.com/AlessioBrillo/dominus/issues/344)) ([38582f0](https://github.com/AlessioBrillo/dominus/commit/38582f0866f0be7549a6dc7750cf69188055e486))
* **team:** plan overrides apply to seat limits ([#319](https://github.com/AlessioBrillo/dominus/issues/319)) ([0217c4a](https://github.com/AlessioBrillo/dominus/commit/0217c4a4e240d54644a2d3be9a52caf40c2c4752))
* **terraform:** separate backup role password, secret-free PITR cron, fix log dir ([#332](https://github.com/AlessioBrillo/dominus/issues/332)) ([b97c814](https://github.com/AlessioBrillo/dominus/commit/b97c814905c9f109fca2f715bde595d00fe8df8b))

## [0.11.0](https://github.com/AlessioBrillo/dominus/compare/v0.10.1...v0.11.0) (2026-08-11)


### Features

* **api:** configurable per-IP rate limits on the public namespace (ADR-0043) ([#255](https://github.com/AlessioBrillo/dominus/issues/255)) ([9662618](https://github.com/AlessioBrillo/dominus/commit/96626183f27302dad3d9b5dd0d4599aad2c54c01))
* **dns:** consensus budget and DoH pooling ([#256](https://github.com/AlessioBrillo/dominus/issues/256)) ([d5aefa4](https://github.com/AlessioBrillo/dominus/commit/d5aefa469e5cad343511fa60eeeb57a4053fbdfe))
* **dns:** majority-vote consensus + fail-degraded failure policy (ADR-0039) ([#251](https://github.com/AlessioBrillo/dominus/issues/251)) ([85217c7](https://github.com/AlessioBrillo/dominus/commit/85217c798f60779db83f009ff9aca80452467e0b))
* **dns:** private recursor for the consensus secondary (ADR-0042) ([#254](https://github.com/AlessioBrillo/dominus/issues/254)) ([00868d7](https://github.com/AlessioBrillo/dominus/commit/00868d778797ad93fb017930266e51c08f8bd406))
* **dns:** tertiary consensus leg rescues Availability (ADR-0045) ([#257](https://github.com/AlessioBrillo/dominus/issues/257)) ([01234a2](https://github.com/AlessioBrillo/dominus/commit/01234a22ba8fe007e7cf7f15f880ce45912fcca7))
* **providers:** per-tenant fair share on shared Redis budgets (ADR-0041) ([#253](https://github.com/AlessioBrillo/dominus/issues/253)) ([a4abf38](https://github.com/AlessioBrillo/dominus/commit/a4abf389f40675679c353d5cfc273a5a35055405))
* **rdap:** shared keep-alive agent pool and consensus config (ADR-0049, ADR-0050) ([#261](https://github.com/AlessioBrillo/dominus/issues/261)) ([a84ebeb](https://github.com/AlessioBrillo/dominus/commit/a84ebeb27f4501454a9049ae46b3508f8ea68774))
* **rdap:** WHOIS rescue leg and startup probe for the 2-of-2 consensus gate (ADR-0051) ([#263](https://github.com/AlessioBrillo/dominus/issues/263)) ([5f7901e](https://github.com/AlessioBrillo/dominus/commit/5f7901e2b33c36596e53dc311bc02985ae4dee4f))
* **rdap:** wire 2-of-2 consensus gate into the pipeline (ADR-0050) ([#262](https://github.com/AlessioBrillo/dominus/issues/262)) ([d76159b](https://github.com/AlessioBrillo/dominus/commit/d76159b14747e82d8491856ba2e06fbf91202fc1))
* **tenancy:** auto-provision free plan + resumable pipeline runs ([#249](https://github.com/AlessioBrillo/dominus/issues/249)) ([81dbaea](https://github.com/AlessioBrillo/dominus/commit/81dbaeabb7646b22c0caec742405c151d1cf380f))
* **usage:** enforce plan allowances at chokepoints (ADR-0038) ([#250](https://github.com/AlessioBrillo/dominus/issues/250)) ([3bca088](https://github.com/AlessioBrillo/dominus/commit/3bca088ca2f76fb3213114f996172981e872046f))
* **whois:** distributed rate-limit parity with per-tenant fair share (ADR-0052) ([#271](https://github.com/AlessioBrillo/dominus/issues/271)) ([89de152](https://github.com/AlessioBrillo/dominus/commit/89de15286aea9e8461aee9914b71d7bea00582a7))


### Bug Fixes

* **dns:** apply 2-of-3 consensus on every resolution path (ADR-0040) ([#252](https://github.com/AlessioBrillo/dominus/issues/252)) ([d5418de](https://github.com/AlessioBrillo/dominus/commit/d5418de8bd5caadea5fa132fec1838d90069e8a9))
* **dns:** custom resolver groups accept the DoH wire format (ADR-0048) ([#260](https://github.com/AlessioBrillo/dominus/issues/260)) ([0baa50e](https://github.com/AlessioBrillo/dominus/commit/0baa50e925b21dfc24c489cf715509d4b18f5156))
* **dns:** serve all three DoH legs live — Google /resolve+ct, Quad9 RFC 8484 wire ([#259](https://github.com/AlessioBrillo/dominus/issues/259)) ([5b2341c](https://github.com/AlessioBrillo/dominus/commit/5b2341c91a67f335fe49805aaa1dc803b6525bc3))
* **security:** api-key management wiring, forced RLS isolation, public origin pinning ([#248](https://github.com/AlessioBrillo/dominus/issues/248)) ([7346e59](https://github.com/AlessioBrillo/dominus/commit/7346e596a54cff6de1384c363d8fad6bca52ffc9))

### [0.10.1](https://github.com/AlessioBrillo/dominus/compare/v0.10.0...v0.10.1) (2026-08-06)


### Features

* acquisition hardening — Kelly allocator, auto-list retry, DropExecutor hard delete ([#174](https://github.com/AlessioBrillo/dominus/issues/174)) ([604fd6c](https://github.com/AlessioBrillo/dominus/commit/604fd6c9249eed76f4a83454a02fb0ed8782c3f8))
* acquisition loop — DNS parallel checkBulk, RDAP 429 handling, registrar pricing ([#136](https://github.com/AlessioBrillo/dominus/issues/136)) ([19333f2](https://github.com/AlessioBrillo/dominus/commit/19333f2bdacd1a746b05c4615329ac61b40a4c82))
* **acquisition:** budget-driven acquisition funnel with infrastructure fixes ([e4ebe05](https://github.com/AlessioBrillo/dominus/commit/e4ebe05a107e434a3d3a19164a87464debcc6347))
* activate multi-tenant isolation ([#138](https://github.com/AlessioBrillo/dominus/issues/138)) ([eb8d88e](https://github.com/AlessioBrillo/dominus/commit/eb8d88eb1a7b5a52ad81861835768d8a3e6a38b5))
* add domain normalization and validation layer ([#129](https://github.com/AlessioBrillo/dominus/issues/129)) ([1832be9](https://github.com/AlessioBrillo/dominus/commit/1832be9724b5ccfc1bf616f1ab700e0885b62c3c))
* **api:** extract JSON-LD helpers, add sitemap images and OG preload ([#135](https://github.com/AlessioBrillo/dominus/issues/135)) ([112986d](https://github.com/AlessioBrillo/dominus/commit/112986d8bd19ba4bf123faf3309c8dc0ad63b4a0))
* **api:** production-harden public namespace with cache, SEO, and rate limiting ([#130](https://github.com/AlessioBrillo/dominus/issues/130)) ([ed58dd9](https://github.com/AlessioBrillo/dominus/commit/ed58dd91c30db968386f601720b12cd41ea8a2a3))
* **auth:** add DB-backed API key management with scrypt hashing ([#118](https://github.com/AlessioBrillo/dominus/issues/118)) ([3390292](https://github.com/AlessioBrillo/dominus/commit/3390292905c585ca0780f9ed9e205f8de96a5962))
* **auth:** wire Cloud auth provider selection (Auth0 + API keys, RBAC) ([#172](https://github.com/AlessioBrillo/dominus/issues/172)) ([e0a6c07](https://github.com/AlessioBrillo/dominus/commit/e0a6c076c738459ce1d87a205b77a4ee3dbc6492))
* **backend:** add configurable renewal cost and auto-backtest on sale ([3e00a27](https://github.com/AlessioBrillo/dominus/commit/3e00a27b22ff8b56d8730cf9b428319eaf51cccd))
* **ci:** add GitHub Actions CI quality gate ([#179](https://github.com/AlessioBrillo/dominus/issues/179)) ([8a29e7e](https://github.com/AlessioBrillo/dominus/commit/8a29e7ef6ca5438b8398801f8b5220923d4cd99e))
* **db:** add DatabasePool, pooled provider, and fix cross-container coordination ([d83fc90](https://github.com/AlessioBrillo/dominus/commit/d83fc900b0d650ddfd656741daf0940c6dc5019d))
* **db:** add multi-tenant data isolation layer ([#115](https://github.com/AlessioBrillo/dominus/issues/115)) ([6923cb3](https://github.com/AlessioBrillo/dominus/commit/6923cb370a70bc8c736ed9955a2f8bcea51410f7))
* **db:** add PostgreSQL RLS policies for tenant data isolation ([#117](https://github.com/AlessioBrillo/dominus/issues/117)) ([3ea9311](https://github.com/AlessioBrillo/dominus/commit/3ea9311657a4037564878f5572f25ee0e2b05e02))
* **db:** auto-discover migrations via filesystem registry ([#128](https://github.com/AlessioBrillo/dominus/issues/128)) ([0c6d1dc](https://github.com/AlessioBrillo/dominus/commit/0c6d1dc9537c63cb55a323ddfa71428452b612ef))
* **dns:** dedicated per-group Resolver, remove global setServers() ([#175](https://github.com/AlessioBrillo/dominus/issues/175)) ([303e3b6](https://github.com/AlessioBrillo/dominus/commit/303e3b6aa2ea1dfb0f3328872102afb4dd13c598))
* **dns:** harden DNS pipeline — rate limiter, resolver groups, pruneCache over clearCache ([9ab0bcf](https://github.com/AlessioBrillo/dominus/commit/9ab0bcf611d3fc1c7e418547d6cd5e4098c9160f))
* **dns:** multi-resolver with DoT/DoH race, persistent cache, IPv6+CDN parking, 2-of-3 consensus ([#169](https://github.com/AlessioBrillo/dominus/issues/169)) ([88b2936](https://github.com/AlessioBrillo/dominus/commit/88b293657b4bcc5a244699f66c37172744c8f65e))
* **dns:** verdict hardening — consensus by default, endpoint-level disjointness, bounded parking probe ([#242](https://github.com/AlessioBrillo/dominus/issues/242)) ([e914020](https://github.com/AlessioBrillo/dominus/commit/e914020c1c06f798465e95df3c97b6abd394f173))
* **frontend:** add outcome API client and record-outcome mutation ([232341b](https://github.com/AlessioBrillo/dominus/commit/232341b83020fe0d0ffc84ae80f211a63aa046e2))
* **frontend:** add RunsPage, WatchlistPage, ScorePage, BacktestPage, SchedulerPage, ProvidersPage ([#157](https://github.com/AlessioBrillo/dominus/issues/157)) ([a3bcb51](https://github.com/AlessioBrillo/dominus/commit/a3bcb51f25fba7f866c316b75c5c9781d9891e0e))
* harden pipeline and deployment for async production ([#119](https://github.com/AlessioBrillo/dominus/issues/119)) ([a80d3f1](https://github.com/AlessioBrillo/dominus/commit/a80d3f186158a8acf868590880a2bd485fc3cbfd))
* **infra:** add Redis infrastructure for distributed locking and caching ([#143](https://github.com/AlessioBrillo/dominus/issues/143)) ([5cc742c](https://github.com/AlessioBrillo/dominus/commit/5cc742c5978286dd1bfa34c021c1bef20e2d4e49))
* **infra:** pipeline throughput optimization + CI hardening ([#158](https://github.com/AlessioBrillo/dominus/issues/158)) ([10ec270](https://github.com/AlessioBrillo/dominus/commit/10ec2700800547d9fd69e037c3300fd0ca84b36d))
* job queue production hardening with observability ([#151](https://github.com/AlessioBrillo/dominus/issues/151)) ([f1d8a40](https://github.com/AlessioBrillo/dominus/commit/f1d8a40686102c6152c8876bba8a754bb8b5e0b1))
* **keyword:** add Google Suggest provider for zero-cost keyword estimation ([#112](https://github.com/AlessioBrillo/dominus/issues/112)) ([d54073e](https://github.com/AlessioBrillo/dominus/commit/d54073ee1de6d1e4d611e44bb62c7c37404c3fd9))
* **net:** DoT connection pool + RDAP per-TLD circuit breakers + live bench ([#199](https://github.com/AlessioBrillo/dominus/issues/199)) ([fe5c7f2](https://github.com/AlessioBrillo/dominus/commit/fe5c7f2f733dfec58de3145c89a7391a89e19692))
* **ops:** v0.10.0 operations readiness — CI matrix, bench infra, security scan, fixes ([#176](https://github.com/AlessioBrillo/dominus/issues/176)) ([13c743b](https://github.com/AlessioBrillo/dominus/commit/13c743bc9c0a72fc2b6167f102d5477c067a3621))
* **pipeline:** add observability and reliability layer ([a2023a6](https://github.com/AlessioBrillo/dominus/commit/a2023a6b239f4f2cf237443060970d4b16fdd192))
* **pipeline:** enable per-tenant concurrent pipeline runs ([d924ede](https://github.com/AlessioBrillo/dominus/commit/d924ede25f15425b37eeb7cc671d3a25e37ffd12))
* **pipeline:** wire checkpoint resume into orchestrator ([#155](https://github.com/AlessioBrillo/dominus/issues/155)) ([8038050](https://github.com/AlessioBrillo/dominus/commit/8038050e9bf4584ed06ffbc1269b133ba27d2bc2))
* production hardening — cache headers, domain validation unification, pipeline lock fencing ([#142](https://github.com/AlessioBrillo/dominus/issues/142)) ([72bed29](https://github.com/AlessioBrillo/dominus/commit/72bed29f01f50f7d36a1d12b3b4abd41a943dc3a))
* production hardening, Auth0 multi-tenant foundation ([#114](https://github.com/AlessioBrillo/dominus/issues/114)) ([3f294f8](https://github.com/AlessioBrillo/dominus/commit/3f294f87d625abd174c9480fdafbe8bcdb2bdce9))
* **provider:** add DNS cross-validation, WHOIS TLS, health check hardening ([#154](https://github.com/AlessioBrillo/dominus/issues/154)) ([b8eb969](https://github.com/AlessioBrillo/dominus/commit/b8eb96983ae15918951b49eaf08042dbabb69a14))
* **providers:** report DNS and RDAP in provider status ([#224](https://github.com/AlessioBrillo/dominus/issues/224)) ([9e2d4ca](https://github.com/AlessioBrillo/dominus/commit/9e2d4ca393fc9bdda229f9cbe802e8dcaa8b282c))
* **provider:** USPTO WAF resilience + health monitoring ([#159](https://github.com/AlessioBrillo/dominus/issues/159)) ([8be8ef1](https://github.com/AlessioBrillo/dominus/commit/8be8ef1f35a10e6617e2366077fe6d3af4d13fcc))
* purchase flow UI + v0.10.0 dependency hardening ([#145](https://github.com/AlessioBrillo/dominus/issues/145)) ([dddf8c8](https://github.com/AlessioBrillo/dominus/commit/dddf8c8b5f9863ae78659a94d55450649e3f103d))
* **rdap:** recheck stale verdicts, bypass cache for closeouts ([#243](https://github.com/AlessioBrillo/dominus/issues/243)) ([db4a85a](https://github.com/AlessioBrillo/dominus/commit/db4a85afcfda3c5401acf2cc58fd93c11622c380))
* **rdap:** warm IANA bootstrap off the hot path ([4cf2986](https://github.com/AlessioBrillo/dominus/commit/4cf2986f5f18b7e0d76eb57aac47ba0f3e166c0f))
* **redis:** wire distributed rate limiting, locking, and Redis client into composition root ([45a60db](https://github.com/AlessioBrillo/dominus/commit/45a60db81b6b66d600e5a2407bbe6df9e0adb5fe))
* SaaS production hardening — billing, tenant isolation, SSE progress, Redis enforcement ([ced5a3a](https://github.com/AlessioBrillo/dominus/commit/ced5a3a33e4a1a8eefd253fef0ac689c68ccb174))
* **scoring:** add market signal data density weighting ([889fe09](https://github.com/AlessioBrillo/dominus/commit/889fe09f92e1dd5588b1a14cbf225b7d04b03c87))
* **ui:** add outcome recording form to OutcomesPage ([0430f14](https://github.com/AlessioBrillo/dominus/commit/0430f14f47c649748360c216aa79d5c6ec20cc39))


### Bug Fixes

* 5 production-hardening fixes — submarine confidence, DoT query ID, DNS concurrency, PG bulk pool, stage-level timeout ([#188](https://github.com/AlessioBrillo/dominus/issues/188)) ([e33185a](https://github.com/AlessioBrillo/dominus/commit/e33185a8032052d339178e641295c669b78a58f4))
* 8 production-hardening fixes — pool close, shutdown, auth, scoring, billing ([ace61c1](https://github.com/AlessioBrillo/dominus/commit/ace61c153f4476d545cfca8223fcf5c70f847214))
* **acquisition-funnel:** stabilize pipeline infrastructure ([fabbc0c](https://github.com/AlessioBrillo/dominus/commit/fabbc0cf132c263210fed77d2d207bfbe761dffe))
* **api:** harden public view buffer, anon cache, and unify migration source ([#139](https://github.com/AlessioBrillo/dominus/issues/139)) ([5d99d09](https://github.com/AlessioBrillo/dominus/commit/5d99d098a93b4ef854d377d728bd480764dc4f02))
* **async:** harden async pipeline execution and job queue ([#141](https://github.com/AlessioBrillo/dominus/issues/141)) ([375b304](https://github.com/AlessioBrillo/dominus/commit/375b3049727e69fd17e2f3e94e1526b09eb0ceb1))
* **auth:** correct auth_rate_limits.reset_at column type for PostgreSQL ([#173](https://github.com/AlessioBrillo/dominus/issues/173)) ([7e65a7f](https://github.com/AlessioBrillo/dominus/commit/7e65a7ff1ee4f007a2fc95f58db08bd581dba2a0))
* bridge repair, test coverage, pagination, bump v0.10.0-dev ([#127](https://github.com/AlessioBrillo/dominus/issues/127)) ([bbc8138](https://github.com/AlessioBrillo/dominus/commit/bbc81388f4718b9197775e9031fd3d6f1fb01143))
* **ci:** exempt dependabot from CLA check ([#200](https://github.com/AlessioBrillo/dominus/issues/200)) ([e926e3b](https://github.com/AlessioBrillo/dominus/commit/e926e3b4d2fec9178bc3228755123cefb5c5e82f))
* **compose:** map scheduler env names and externalize db credentials ([#211](https://github.com/AlessioBrillo/dominus/issues/211)) ([5dc049d](https://github.com/AlessioBrillo/dominus/commit/5dc049d48da7c44971465f253a1012d45e051027))
* **config:** align DNS parking and bulk concurrency defaults with docs ([#223](https://github.com/AlessioBrillo/dominus/issues/223)) ([ceefb94](https://github.com/AlessioBrillo/dominus/commit/ceefb94277e0da40a6a981f27599263e8b9d382c))
* **db:** add missing tenant_id to listing_offers table and repository ([#140](https://github.com/AlessioBrillo/dominus/issues/140)) ([50b36c5](https://github.com/AlessioBrillo/dominus/commit/50b36c52b2c6dcc83e311013f3a40834486a8fc2))
* **db:** normalize timestamp format for cross-dialect SQL compatibility ([#122](https://github.com/AlessioBrillo/dominus/issues/122)) ([00566d4](https://github.com/AlessioBrillo/dominus/commit/00566d4d6a13016f9f57669c1ac9ad470154ccf2))
* **deploy)+feat(observability:** full-stack compose, Prometheus metrics, monitoring stack, restore drill ([#244](https://github.com/AlessioBrillo/dominus/issues/244)) ([b207c85](https://github.com/AlessioBrillo/dominus/commit/b207c8586b88cc3b1ee714beb751bb8437f45c5c))
* **deps:** bump ip-address 10.4.0 and override uuid 11.1.1 ([dd96974](https://github.com/AlessioBrillo/dominus/commit/dd969741c50ae7e8493bbc54f1597bc109057fc8)), closes [#16](https://github.com/AlessioBrillo/dominus/issues/16) [#26](https://github.com/AlessioBrillo/dominus/issues/26)
* **dns:** bound dot pool queue and dispose pools on shutdown ([#210](https://github.com/AlessioBrillo/dominus/issues/210)) ([5d60c89](https://github.com/AlessioBrillo/dominus/commit/5d60c895e2313121063e38cb0b2a66f215f9a9fd))
* **dns:** closeout CSV candidates now pass through DNS with forceRecheck ([#177](https://github.com/AlessioBrillo/dominus/issues/177)) ([73ed028](https://github.com/AlessioBrillo/dominus/commit/73ed0280317b2e01206fb43c131ee8cda469e363))
* **dns:** conservative group decisions, collision-proof DoT IDs, RDAP per-TLD scope ([#205](https://github.com/AlessioBrillo/dominus/issues/205)) ([91cb0b6](https://github.com/AlessioBrillo/dominus/commit/91cb0b64e1c3da65f58677e6b198426803e9ba64))
* **dns:** handle generic fetch errors in DoH phase, add doh-only tests ([f5f3f4c](https://github.com/AlessioBrillo/dominus/commit/f5f3f4cc70d313df615ef3c671e389072075d0e4))
* **dns:** honor cache disable semantics and never persist unknown ([#209](https://github.com/AlessioBrillo/dominus/issues/209)) ([25ea824](https://github.com/AlessioBrillo/dominus/commit/25ea824ecd1659b25c2f14ebd7dc29112761789e))
* **dns:** randomize DoT query ID to prevent DNS spoofing ([#185](https://github.com/AlessioBrillo/dominus/issues/185)) ([e8fa26f](https://github.com/AlessioBrillo/dominus/commit/e8fa26fcbcb12a731f5c222396f491372684f9e1))
* **dns:** re-check stale Available rows from the persistent cache ([b95b726](https://github.com/AlessioBrillo/dominus/commit/b95b726a3a7e996a3a963f3369236a2937553a3f))
* **dns:** reject late queries after dot pool close with ECLOSED ([#227](https://github.com/AlessioBrillo/dominus/issues/227)) ([a5ad656](https://github.com/AlessioBrillo/dominus/commit/a5ad6565d9e63aa4f4aa9953ff27f42a42cc4043))
* **dns:** restore real native fallback for doh-primary ([#208](https://github.com/AlessioBrillo/dominus/issues/208)) ([7028b98](https://github.com/AlessioBrillo/dominus/commit/7028b986f2e2f39db9359e17705cfad7f0bf35ae))
* **dns:** strict 2-of-3 consensus — unknown secondary downgrades verdict ([#245](https://github.com/AlessioBrillo/dominus/issues/245)) ([7680663](https://github.com/AlessioBrillo/dominus/commit/7680663b4a53b15e48d43c3cf439568ef5b0eba7))
* **docker:** restore better-sqlite3 binding + CI runtime smoke test ([#207](https://github.com/AlessioBrillo/dominus/issues/207)) ([5c1d3e1](https://github.com/AlessioBrillo/dominus/commit/5c1d3e135c9a888883db61c8d208b475c7a45486))
* **docker:** unignore THIRD-PARTY-NOTICES.md from build context ([003dbb5](https://github.com/AlessioBrillo/dominus/commit/003dbb51683f1d6da70969ea976985f8fb8d0b40)), closes [#196](https://github.com/AlessioBrillo/dominus/issues/196)
* **infra:** pipeline hardening - DoH, RDAP, signal, batches ([#156](https://github.com/AlessioBrillo/dominus/issues/156)) ([94e96a8](https://github.com/AlessioBrillo/dominus/commit/94e96a8abdaea0fb3260ca05cacee4e1ca601fc9))
* **infra:** production hardening — RDAP rate limiters, USPTO degrade, WHOIS cache ([#153](https://github.com/AlessioBrillo/dominus/issues/153)) ([a476b94](https://github.com/AlessioBrillo/dominus/commit/a476b948ae40f3ea8388e3ef3b61ee9343d29de3)), closes [#149](https://github.com/AlessioBrillo/dominus/issues/149) [#150](https://github.com/AlessioBrillo/dominus/issues/150)
* **jobs:** harden job-queue concurrency for multi-worker Postgres ([#170](https://github.com/AlessioBrillo/dominus/issues/170)) ([25e97ae](https://github.com/AlessioBrillo/dominus/commit/25e97aead875dc39ff72460713da4adf12ee1ac0))
* **k8s:** harden deployment for read-only rootfs and RWO volume ([#218](https://github.com/AlessioBrillo/dominus/issues/218)) ([d0a2613](https://github.com/AlessioBrillo/dominus/commit/d0a26136d53a8e5de30867fb1b5093fd45d25a30))
* **pipeline:** abort on external signal race and TOCTOU tenant check ([#186](https://github.com/AlessioBrillo/dominus/issues/186)) ([fd226c7](https://github.com/AlessioBrillo/dominus/commit/fd226c773149aff19d7df49f13ac893dbb8f0d26))
* **pipeline:** run integrity at scale — candidate-scaled stage budgets + degraded output surfacing ([#241](https://github.com/AlessioBrillo/dominus/issues/241)) ([065e2c5](https://github.com/AlessioBrillo/dominus/commit/065e2c59fcfa0f8c07f205c0fecef9e636122225))
* **portfolio:** compute renewal days on calendar days, not 24h deltas ([#219](https://github.com/AlessioBrillo/dominus/issues/219)) ([45fa7aa](https://github.com/AlessioBrillo/dominus/commit/45fa7aa53a5595d0ba4e9f0b770f100f56b904ba))
* **prod:** atomic usage enforcement, durable webhook idempotency, 3-tier billing ([#190](https://github.com/AlessioBrillo/dominus/issues/190)) ([baa0e34](https://github.com/AlessioBrillo/dominus/commit/baa0e3401b2f996ebab2a540e4c77709f5edec55))
* production-harden pipeline locks, CSP, DNS, and provider types ([5cb4c73](https://github.com/AlessioBrillo/dominus/commit/5cb4c73d5babf81e60ae662e3c1c0b80244f32e6))
* **public:** gate suggestedBuyMax behind trademark clearance ([#206](https://github.com/AlessioBrillo/dominus/issues/206)) ([74d2e1d](https://github.com/AlessioBrillo/dominus/commit/74d2e1d10468818ff20f19f8b3e81e657e00a0d7))
* **public:** make canonical site URL configurable via PUBLIC_APP_URL ([#239](https://github.com/AlessioBrillo/dominus/issues/239)) ([9ce8dc0](https://github.com/AlessioBrillo/dominus/commit/9ce8dc04005716a6d9aebaaa02d8b61006841a43))
* **public:** strip buy-max when trademark not clear; dedup and cache ([#234](https://github.com/AlessioBrillo/dominus/issues/234)) ([96f822a](https://github.com/AlessioBrillo/dominus/commit/96f822a28348d90499d39a0d337a8955f8676668))
* **rdap:** authoritative per-TLD bootstrap resolution ([#198](https://github.com/AlessioBrillo/dominus/issues/198)) ([1a579ff](https://github.com/AlessioBrillo/dominus/commit/1a579fff7d6cf70da868b3a48579c87739d4ad81))
* **rdap:** never persist unknown results in provider cache ([#226](https://github.com/AlessioBrillo/dominus/issues/226)) ([d9025e1](https://github.com/AlessioBrillo/dominus/commit/d9025e13ca62b28b9e7a171d59a550557ad6ca22))
* **rdap:** share circuit breaker state across containers via Redis ([#221](https://github.com/AlessioBrillo/dominus/issues/221)) ([43c0213](https://github.com/AlessioBrillo/dominus/commit/43c0213632d28d41f95a626fc8a6228548569d8a))
* **redis:** bound rate limiter polling with a wait budget and fail fast ([#222](https://github.com/AlessioBrillo/dominus/issues/222)) ([f7d9be4](https://github.com/AlessioBrillo/dominus/commit/f7d9be42177d9263b895523095912dbe78cdabee))
* **redis:** CompositeLockProvider split-brain fix + DistributedCircuitBreaker + graceful shutdown ([#167](https://github.com/AlessioBrillo/dominus/issues/167)) ([885b371](https://github.com/AlessioBrillo/dominus/commit/885b3716a536c7a3efaf8b748bcbbc1e0c63cd32))
* **reliability:** wire portfolio healthcheck, honor DNS cache TTL, opt-in DNS consensus ([#171](https://github.com/AlessioBrillo/dominus/issues/171)) ([4dc6e98](https://github.com/AlessioBrillo/dominus/commit/4dc6e98248cf45803200f970fe7c96ed62020ee7))
* remove hardcoded CORS * from public-router, rely on global CORS middleware ([a6438b6](https://github.com/AlessioBrillo/dominus/commit/a6438b6a5faa5dd03d92516611f2a357df7a5f9f)), closes [#8](https://github.com/AlessioBrillo/dominus/issues/8)
* resolve 5 CodeQL code scanning alerts ([#116](https://github.com/AlessioBrillo/dominus/issues/116)) ([497a1c1](https://github.com/AlessioBrillo/dominus/commit/497a1c14d6c06212b5b3576b36f7ebd05c66ec8c))
* resolve type errors, ESLint compat, DNS unknown handling ([81159fe](https://github.com/AlessioBrillo/dominus/commit/81159fe907d2f96034ae4ac36bbe7beaad176318))
* schema divergence, DNS hardening, scoring confidence, security, pipeline observability ([#124](https://github.com/AlessioBrillo/dominus/issues/124)) ([c45fdc2](https://github.com/AlessioBrillo/dominus/commit/c45fdc2e18b81599a9d5d3f7fe1cc91ca4fc147b))
* **scoring:** isolate raw SQL queries by tenant_id ([#123](https://github.com/AlessioBrillo/dominus/issues/123)) ([72662e6](https://github.com/AlessioBrillo/dominus/commit/72662e665a1bae976c12aed8bb9eee6d1a01ad76))
* **scoring:** sort by date for recencyFactor, not by price ([#187](https://github.com/AlessioBrillo/dominus/issues/187)) ([3e4869f](https://github.com/AlessioBrillo/dominus/commit/3e4869f0be5b8b554dd398e29e3e4b4c09277b82))

## 0.10.0 (2026-08-04)


### Features

* acquisition hardening — Kelly allocator, auto-list retry, DropExecutor hard delete ([#174](https://github.com/AlessioBrillo/dominus/issues/174)) ([604fd6c](https://github.com/AlessioBrillo/dominus/commit/604fd6c9249eed76f4a83454a02fb0ed8782c3f8))
* acquisition loop — DNS parallel checkBulk, RDAP 429 handling, registrar pricing ([#136](https://github.com/AlessioBrillo/dominus/issues/136)) ([19333f2](https://github.com/AlessioBrillo/dominus/commit/19333f2bdacd1a746b05c4615329ac61b40a4c82))
* **acquisition:** budget-driven acquisition funnel with infrastructure fixes ([e4ebe05](https://github.com/AlessioBrillo/dominus/commit/e4ebe05a107e434a3d3a19164a87464debcc6347))
* activate multi-tenant isolation ([#138](https://github.com/AlessioBrillo/dominus/issues/138)) ([eb8d88e](https://github.com/AlessioBrillo/dominus/commit/eb8d88eb1a7b5a52ad81861835768d8a3e6a38b5))
* add DNS parking page detection for aftermarket domains ([b073f1d](https://github.com/AlessioBrillo/dominus/commit/b073f1d92bfea2f3c35c96461c9c8e175dfc579f))
* add Docker, health CLI, security docs, and release workflow ([#34](https://github.com/AlessioBrillo/dominus/issues/34)) ([4ae07aa](https://github.com/AlessioBrillo/dominus/commit/4ae07aa713ffb69f45ade3bf91764b101b6ff728))
* add domain normalization and validation layer ([#129](https://github.com/AlessioBrillo/dominus/issues/129)) ([1832be9](https://github.com/AlessioBrillo/dominus/commit/1832be9724b5ccfc1bf616f1ab700e0885b62c3c))
* add Portfolio P&L tracking and Analytics frontend page (ADR-0024) ([bf639ca](https://github.com/AlessioBrillo/dominus/commit/bf639cae7dac97d0e5480f076a22530bb00ad9c6))
* add sample keyword and comparable sales data files ([#36](https://github.com/AlessioBrillo/dominus/issues/36)) ([07feb80](https://github.com/AlessioBrillo/dominus/commit/07feb80db2d7a8950a61159b30940d7a5e9c0bd0))
* add sqlite-based job queue and worker pool ([908f236](https://github.com/AlessioBrillo/dominus/commit/908f2361c8cd1c0df9e77821e4369ca9ea62218d))
* **analytics:** add prediction accuracy analyzer and analytics pipeline ([#64](https://github.com/AlessioBrillo/dominus/issues/64)) ([20d8059](https://github.com/AlessioBrillo/dominus/commit/20d8059f894027d0947737fc7266fc330fb51ae6))
* **api,frontend:** add onboarding, score sharing, and seo pages ([#81](https://github.com/AlessioBrillo/dominus/issues/81)) ([03f5694](https://github.com/AlessioBrillo/dominus/commit/03f56947478bfd7b94bc18fd8a1780a1d327fd59))
* **api:** complete API REST with health, score, backtest, providers, outcomes + scoring fixes ([#28](https://github.com/AlessioBrillo/dominus/issues/28)) ([5f93f9f](https://github.com/AlessioBrillo/dominus/commit/5f93f9f23f7ea538a1016e1a55f205f2bb27071f))
* **api:** extract JSON-LD helpers, add sitemap images and OG preload ([#135](https://github.com/AlessioBrillo/dominus/issues/135)) ([112986d](https://github.com/AlessioBrillo/dominus/commit/112986d8bd19ba4bf123faf3309c8dc0ad63b4a0))
* **api:** production-harden public namespace with cache, SEO, and rate limiting ([#130](https://github.com/AlessioBrillo/dominus/issues/130)) ([ed58dd9](https://github.com/AlessioBrillo/dominus/commit/ed58dd91c30db968386f601720b12cd41ea8a2a3))
* **auth:** add DB-backed API key management with scrypt hashing ([#118](https://github.com/AlessioBrillo/dominus/issues/118)) ([3390292](https://github.com/AlessioBrillo/dominus/commit/3390292905c585ca0780f9ed9e205f8de96a5962))
* **auth:** wire Cloud auth provider selection (Auth0 + API keys, RBAC) ([#172](https://github.com/AlessioBrillo/dominus/issues/172)) ([e0a6c07](https://github.com/AlessioBrillo/dominus/commit/e0a6c076c738459ce1d87a205b77a4ee3dbc6492))
* **backend:** add configurable renewal cost and auto-backtest on sale ([3e00a27](https://github.com/AlessioBrillo/dominus/commit/3e00a27b22ff8b56d8730cf9b428319eaf51cccd))
* **backtest:** close outcomes→scoring calibration loop ([#6](https://github.com/AlessioBrillo/dominus/issues/6)) ([218b785](https://github.com/AlessioBrillo/dominus/commit/218b7852c056e0d57ed204d1185a3dd26d2a9e12)), closes [#5](https://github.com/AlessioBrillo/dominus/issues/5)
* **build:** align architecture for open-source forking and customization ([#43](https://github.com/AlessioBrillo/dominus/issues/43)) ([2595a69](https://github.com/AlessioBrillo/dominus/commit/2595a694e372aa7f104f3347da6211fa0db46655))
* **candidates:** closeout CSV import feeding real expiry signals (Stage 1) ([#4](https://github.com/AlessioBrillo/dominus/issues/4)) ([b0258e4](https://github.com/AlessioBrillo/dominus/commit/b0258e47e073e61560280753b283c6b8e9a6b2ca))
* **ci:** add GitHub Actions CI quality gate ([#179](https://github.com/AlessioBrillo/dominus/issues/179)) ([8a29e7e](https://github.com/AlessioBrillo/dominus/commit/8a29e7ef6ca5438b8398801f8b5220923d4cd99e))
* CLA, trademark gate, OG images, and DatabaseProvider refactor ([#89](https://github.com/AlessioBrillo/dominus/issues/89)) ([bdac7d0](https://github.com/AlessioBrillo/dominus/commit/bdac7d05b2ead1aa2637f2045b600cd4aa0a24d0))
* **cli:** add backup command, prune --before flag, countBefore/pruneBefore repository methods ([#31](https://github.com/AlessioBrillo/dominus/issues/31)) ([3c097a6](https://github.com/AlessioBrillo/dominus/commit/3c097a6f7bdc056e77578078a755126fc7ab401c))
* complete bid tracking system ([#67](https://github.com/AlessioBrillo/dominus/issues/67)) ([f6dc8f0](https://github.com/AlessioBrillo/dominus/commit/f6dc8f0dc8969146e05ae02814a4a2adf64b2306))
* connect job queue to CLI and API (ADR-0023 Phase 2) ([#69](https://github.com/AlessioBrillo/dominus/issues/69)) ([f8356a8](https://github.com/AlessioBrillo/dominus/commit/f8356a8207ec7ce595191934b445df6d883982b8))
* db concurrency — dedicated bulk-write SQLite, parallel RDAP failover, cache-busting, WHOIS rate limit tuning ([1a01255](https://github.com/AlessioBrillo/dominus/commit/1a01255a209323c0af2ac8c975a3b4929785cab5)), closes [#95](https://github.com/AlessioBrillo/dominus/issues/95)
* **db:** add DatabasePool, pooled provider, and fix cross-container coordination ([d83fc90](https://github.com/AlessioBrillo/dominus/commit/d83fc900b0d650ddfd656741daf0940c6dc5019d))
* **db:** add multi-tenant data isolation layer ([#115](https://github.com/AlessioBrillo/dominus/issues/115)) ([6923cb3](https://github.com/AlessioBrillo/dominus/commit/6923cb370a70bc8c736ed9955a2f8bcea51410f7))
* **db:** add PostgreSQL adapter for cloud edition ([894bbac](https://github.com/AlessioBrillo/dominus/commit/894bbace3e7cb576583b8f2f7d5c6cee7c7ddce7))
* **db:** add PostgreSQL RLS policies for tenant data isolation ([#117](https://github.com/AlessioBrillo/dominus/issues/117)) ([3ea9311](https://github.com/AlessioBrillo/dominus/commit/3ea9311657a4037564878f5572f25ee0e2b05e02))
* **db:** auto-discover migrations via filesystem registry ([#128](https://github.com/AlessioBrillo/dominus/issues/128)) ([0c6d1dc](https://github.com/AlessioBrillo/dominus/commit/0c6d1dc9537c63cb55a323ddfa71428452b612ef))
* **db:** complete DatabaseProvider abstraction in backup, backtest, analytics ([#100](https://github.com/AlessioBrillo/dominus/issues/100)) ([163200b](https://github.com/AlessioBrillo/dominus/commit/163200b0606f50575fcbbc133a62ebd9864b0a8f))
* **db:** migrate all repositories to sync DatabaseProvider interface ([87fd37d](https://github.com/AlessioBrillo/dominus/commit/87fd37db3e7cda25932b51f7f16529ee6af0afa9))
* **dns:** add DNS_BULK_CONCURRENCY env cap to node-dns-provider ([#25](https://github.com/AlessioBrillo/dominus/issues/25)) ([7535fa6](https://github.com/AlessioBrillo/dominus/commit/7535fa6758c4931e1e0945cb13b644045623e364))
* **dns:** dedicated per-group Resolver, remove global setServers() ([#175](https://github.com/AlessioBrillo/dominus/issues/175)) ([303e3b6](https://github.com/AlessioBrillo/dominus/commit/303e3b6aa2ea1dfb0f3328872102afb4dd13c598))
* **dns:** harden DNS pipeline — rate limiter, resolver groups, pruneCache over clearCache ([9ab0bcf](https://github.com/AlessioBrillo/dominus/commit/9ab0bcf611d3fc1c7e418547d6cd5e4098c9160f))
* **dns:** multi-resolver with DoT/DoH race, persistent cache, IPv6+CDN parking, 2-of-3 consensus ([#169](https://github.com/AlessioBrillo/dominus/issues/169)) ([88b2936](https://github.com/AlessioBrillo/dominus/commit/88b293657b4bcc5a244699f66c37172744c8f65e))
* **domain:** adopt full Public Suffix List via psl package ([#24](https://github.com/AlessioBrillo/dominus/issues/24)) ([e71909d](https://github.com/AlessioBrillo/dominus/commit/e71909d72047eb640b9aa7dfd5c1be53e49a730d))
* enable scoring engine with sample data, fix TLD pricing, harden frontend ([#62](https://github.com/AlessioBrillo/dominus/issues/62)) ([609103a](https://github.com/AlessioBrillo/dominus/commit/609103a52a526aa1fd6001245a2f1d8555218774))
* foundation hardening — type safety, deployment config, migration sync, public router refactor ([034028e](https://github.com/AlessioBrillo/dominus/commit/034028e872f35c6620d4965639dabc13d531dade))
* **frontend:** add outcome API client and record-outcome mutation ([232341b](https://github.com/AlessioBrillo/dominus/commit/232341b83020fe0d0ffc84ae80f211a63aa046e2))
* **frontend:** add RunsPage, WatchlistPage, ScorePage, BacktestPage, SchedulerPage, ProvidersPage ([#157](https://github.com/AlessioBrillo/dominus/issues/157)) ([a3bcb51](https://github.com/AlessioBrillo/dominus/commit/a3bcb51f25fba7f866c316b75c5c9781d9891e0e))
* **frontend:** complete UI redesign with shadcn/ui, Recharts, TanStack Table ([10797ac](https://github.com/AlessioBrillo/dominus/commit/10797ac69ceb27339361435ec8d4dfa345746357))
* **frontend:** integrate React dashboard with backend API + infrastructure hardening ([97a1fce](https://github.com/AlessioBrillo/dominus/commit/97a1fce3ba4cc513dd61bed321f54cc3ca33090f))
* **frontend:** migrate pages to React Query hooks with comprehensive tests ([776acc7](https://github.com/AlessioBrillo/dominus/commit/776acc74d294b9da343be3a573e557ecbf15097b))
* harden confidence coverage, orchestrator/dns/trademark tests, security fixes ([0733b6a](https://github.com/AlessioBrillo/dominus/commit/0733b6a153dfef691968504ab38472610f6619d1))
* harden pipeline and deployment for async production ([#119](https://github.com/AlessioBrillo/dominus/issues/119)) ([a80d3f1](https://github.com/AlessioBrillo/dominus/commit/a80d3f186158a8acf868590880a2bd485fc3cbfd))
* **infra:** add Redis infrastructure for distributed locking and caching ([#143](https://github.com/AlessioBrillo/dominus/issues/143)) ([5cc742c](https://github.com/AlessioBrillo/dominus/commit/5cc742c5978286dd1bfa34c021c1bef20e2d4e49))
* **infra:** pipeline throughput optimization + CI hardening ([#158](https://github.com/AlessioBrillo/dominus/issues/158)) ([10ec270](https://github.com/AlessioBrillo/dominus/commit/10ec2700800547d9fd69e037c3300fd0ca84b36d))
* infrastructure hardening and Phase 1 React dashboard ([#48](https://github.com/AlessioBrillo/dominus/issues/48)) ([11e3658](https://github.com/AlessioBrillo/dominus/commit/11e36581e92e79e8b422ee9ab3f2bbc1a933bf14))
* initial implementation — local CI, portfolio UI, DNS parallelization, incremental pipeline ([#94](https://github.com/AlessioBrillo/dominus/issues/94)) ([6b3c9ec](https://github.com/AlessioBrillo/dominus/commit/6b3c9ecf7cfe0938818319f1fa70522cda5b5b80))
* job queue production hardening with observability ([#151](https://github.com/AlessioBrillo/dominus/issues/151)) ([f1d8a40](https://github.com/AlessioBrillo/dominus/commit/f1d8a40686102c6152c8876bba8a754bb8b5e0b1))
* **keyword:** add Google Suggest provider for zero-cost keyword estimation ([#112](https://github.com/AlessioBrillo/dominus/issues/112)) ([d54073e](https://github.com/AlessioBrillo/dominus/commit/d54073ee1de6d1e4d611e44bb62c7c37404c3fd9))
* **listing:** add Listing & Sales Pipeline Manager ([#75](https://github.com/AlessioBrillo/dominus/issues/75)) ([6778e15](https://github.com/AlessioBrillo/dominus/commit/6778e150a46c32531fa127f1aa02573495206019))
* **listing:** close the acquisition-to-marketplace-listing loop ([#96](https://github.com/AlessioBrillo/dominus/issues/96)) ([9026f71](https://github.com/AlessioBrillo/dominus/commit/9026f712188aeff099f746b691c5e15f835ca9d1))
* listings frontend page, DNS MX fix, and API hardening ([#98](https://github.com/AlessioBrillo/dominus/issues/98)) ([d009d33](https://github.com/AlessioBrillo/dominus/commit/d009d33826af69a74afe13a5d5093053b0dd0079))
* make job queue the default execution path (ADR-0023 Phase 2) ([#72](https://github.com/AlessioBrillo/dominus/issues/72)) ([7017c02](https://github.com/AlessioBrillo/dominus/commit/7017c0203eb9fc51920096456dffa16283bc1003))
* monorepo observability — metrics, SSE progress, TM rate limiters, frontend RunProgress ([#63](https://github.com/AlessioBrillo/dominus/issues/63)) ([7754d34](https://github.com/AlessioBrillo/dominus/commit/7754d346154ac0d08c78732babf967a56af391e3))
* **net:** DoT connection pool + RDAP per-TLD circuit breakers + live bench ([#199](https://github.com/AlessioBrillo/dominus/issues/199)) ([fe5c7f2](https://github.com/AlessioBrillo/dominus/commit/fe5c7f2f733dfec58de3145c89a7391a89e19692))
* **observability:** add MetricsCollector and pipeline telemetry ([a33d873](https://github.com/AlessioBrillo/dominus/commit/a33d873aa6af0d20f3cf439205ceed5238d779b4))
* **ops:** v0.10.0 operations readiness — CI matrix, bench infra, security scan, fixes ([#176](https://github.com/AlessioBrillo/dominus/issues/176)) ([13c743b](https://github.com/AlessioBrillo/dominus/commit/13c743bc9c0a72fc2b6167f102d5477c067a3621))
* persistent end-to-end sieve (Phase 1) ([47cb485](https://github.com/AlessioBrillo/dominus/commit/47cb485684d85226aec9015972e0912b299bab40))
* **pipeline:** add observability and reliability layer ([a2023a6](https://github.com/AlessioBrillo/dominus/commit/a2023a6b239f4f2cf237443060970d4b16fdd192))
* **pipeline:** add WhoisStage, db hardening, domain validation ([75a9a22](https://github.com/AlessioBrillo/dominus/commit/75a9a22212c28da837a0db699bcaa3052c0fd417))
* **pipeline:** durable pipeline_runs history (ADR-0011) + 5 risk fixes ([#7](https://github.com/AlessioBrillo/dominus/issues/7)) ([1ea67ef](https://github.com/AlessioBrillo/dominus/commit/1ea67ef93283014db2edbb79442e96795ac19aaa))
* **pipeline:** enable per-tenant concurrent pipeline runs ([d924ede](https://github.com/AlessioBrillo/dominus/commit/d924ede25f15425b37eeb7cc671d3a25e37ffd12))
* **pipeline:** wire checkpoint resume into orchestrator ([#155](https://github.com/AlessioBrillo/dominus/issues/155)) ([8038050](https://github.com/AlessioBrillo/dominus/commit/8038050e9bf4584ed06ffbc1269b133ba27d2bc2))
* **portfolio:** add portfolio report, security headers, infra hardening ([a886ca3](https://github.com/AlessioBrillo/dominus/commit/a886ca30a34adb3a39c1b0c4ab9b864537851d05))
* **portfolio:** re-score bridge + outcomes tracking ([#5](https://github.com/AlessioBrillo/dominus/issues/5)) ([6c46dee](https://github.com/AlessioBrillo/dominus/commit/6c46dee1e50bc97d45a4aeaa1c95da8ea111a1cf))
* production hardening — cache headers, domain validation unification, pipeline lock fencing ([#142](https://github.com/AlessioBrillo/dominus/issues/142)) ([72bed29](https://github.com/AlessioBrillo/dominus/commit/72bed29f01f50f7d36a1d12b3b4abd41a943dc3a))
* production hardening sprint — CSP, DI, rate limiting, retry consolidation, DnsProvider, benchmarks ([#102](https://github.com/AlessioBrillo/dominus/issues/102)) ([b5611b4](https://github.com/AlessioBrillo/dominus/commit/b5611b46a3c0589b6873c6249518a9fe0e46150f))
* production hardening, Auth0 multi-tenant foundation ([#114](https://github.com/AlessioBrillo/dominus/issues/114)) ([3f294f8](https://github.com/AlessioBrillo/dominus/commit/3f294f87d625abd174c9480fdafbe8bcdb2bdce9))
* provider resilience, observability, and infrastructure hardening ([48746a0](https://github.com/AlessioBrillo/dominus/commit/48746a08018362cb63fdbdbc5d819941fea9042d))
* **provider/dns:** add per-lookup timeout and resilient bulk checks ([5a79688](https://github.com/AlessioBrillo/dominus/commit/5a796881f362a2c93b76fea042dda12dd2e1faaf))
* **provider/wayback:** add Wayback CDX provider for automatic expiry enrichment ([#86](https://github.com/AlessioBrillo/dominus/issues/86)) ([c2cf94f](https://github.com/AlessioBrillo/dominus/commit/c2cf94fcfd6d3afe6493af9bc68adce416dce542))
* **provider/whois:** add RetryingWhoisProvider with circuit breaker ([3caed9f](https://github.com/AlessioBrillo/dominus/commit/3caed9f05b66a874fa2ad8eb113d2952f9f8cba0))
* **provider:** add Cloudflare Registrar provider implementation ([#39](https://github.com/AlessioBrillo/dominus/issues/39)) ([92c7d2a](https://github.com/AlessioBrillo/dominus/commit/92c7d2a3167330b727d0d24d3c11ef16ea3e9ebe))
* **provider:** add DNS cross-validation, WHOIS TLS, health check hardening ([#154](https://github.com/AlessioBrillo/dominus/issues/154)) ([b8eb969](https://github.com/AlessioBrillo/dominus/commit/b8eb96983ae15918951b49eaf08042dbabb69a14))
* **provider:** add rate limiter, maintenance rescore prune, and coverage tests ([0c4e647](https://github.com/AlessioBrillo/dominus/commit/0c4e6472d5f4af326dd1b926db9d7ed03875a2e7))
* **provider:** add RegistrarProvider interface with ManualRegistrarProvider ([#35](https://github.com/AlessioBrillo/dominus/issues/35)) ([a2be54a](https://github.com/AlessioBrillo/dominus/commit/a2be54a3f96efa80e9f873b181c21fe33934e311))
* **provider:** complete registrar ecosystem with purchase bridge ([9a5375c](https://github.com/AlessioBrillo/dominus/commit/9a5375c2a471211d23e0a4828ea0cfd6b49a541c))
* **providers:** add RDAP caching, DNS retry, signal tracking, NPV drop verdict ([#56](https://github.com/AlessioBrillo/dominus/issues/56)) ([145aeb1](https://github.com/AlessioBrillo/dominus/commit/145aeb13d32c602f3f135059d80a5f6f79f500cb))
* **providers:** report DNS and RDAP in provider status ([#224](https://github.com/AlessioBrillo/dominus/issues/224)) ([9e2d4ca](https://github.com/AlessioBrillo/dominus/commit/9e2d4ca393fc9bdda229f9cbe802e8dcaa8b282c))
* **provider:** USPTO WAF resilience + health monitoring ([#159](https://github.com/AlessioBrillo/dominus/issues/159)) ([8be8ef1](https://github.com/AlessioBrillo/dominus/commit/8be8ef1f35a10e6617e2366077fe6d3af4d13fcc))
* purchase flow UI + v0.10.0 dependency hardening ([#145](https://github.com/AlessioBrillo/dominus/issues/145)) ([dddf8c8](https://github.com/AlessioBrillo/dominus/commit/dddf8c8b5f9863ae78659a94d55450649e3f103d))
* quality infrastructure and API authentication ([#42](https://github.com/AlessioBrillo/dominus/issues/42)) ([d84cbd4](https://github.com/AlessioBrillo/dominus/commit/d84cbd484af57a009ff407105182a5ae45d49de2))
* **rdap:** warm IANA bootstrap off the hot path ([4cf2986](https://github.com/AlessioBrillo/dominus/commit/4cf2986f5f18b7e0d76eb57aac47ba0f3e166c0f))
* **redis:** wire distributed rate limiting, locking, and Redis client into composition root ([45a60db](https://github.com/AlessioBrillo/dominus/commit/45a60db81b6b66d600e5a2407bbe6df9e0adb5fe))
* **registrar:** add CloudflareRegistrarProvider with API v4 integration ([8a80bd5](https://github.com/AlessioBrillo/dominus/commit/8a80bd5c3561c0680c1fc3efcaa9602d0d9232a2))
* renewal monitoring and alert system with scheduler ([#38](https://github.com/AlessioBrillo/dominus/issues/38)) ([9dfc10a](https://github.com/AlessioBrillo/dominus/commit/9dfc10aff097074c9fb7d9372220742d0722bbf0))
* SaaS production hardening — billing, tenant isolation, SSE progress, Redis enforcement ([ced5a3a](https://github.com/AlessioBrillo/dominus/commit/ced5a3a33e4a1a8eefd253fef0ac689c68ccb174))
* scaffold complete DOMINUS project skeleton ([2771c64](https://github.com/AlessioBrillo/dominus/commit/2771c640ddbbd29b79147d1f7fb8abc2ebd7fea2))
* **scoring:** add market signal data density weighting ([889fe09](https://github.com/AlessioBrillo/dominus/commit/889fe09f92e1dd5588b1a14cbf225b7d04b03c87))
* **scoring:** closed-loop auto weight tuning system ([#45](https://github.com/AlessioBrillo/dominus/issues/45)) ([6c8bdfb](https://github.com/AlessioBrillo/dominus/commit/6c8bdfb67214a90527759514bcf0a52a6a359316))
* **scoring:** fix recommendation deadlock and add acquisition tracking ([0c3ee94](https://github.com/AlessioBrillo/dominus/commit/0c3ee943fbb7409ba0409a06c4744ec47ca75572))
* **scoring:** parallelize ScoringStage with configurable batch concurrency ([#91](https://github.com/AlessioBrillo/dominus/issues/91)) ([150b0a3](https://github.com/AlessioBrillo/dominus/commit/150b0a373077889547725cd8118581310f4c87b2))
* test infra hardening, notifier tests, configurable providers ([#46](https://github.com/AlessioBrillo/dominus/issues/46)) ([663fbb7](https://github.com/AlessioBrillo/dominus/commit/663fbb72b6268cb5b0dd4bec14a7aa6976c9ff74))
* **trademark:** real USPTO/EUIPO providers + graceful gate + TM result cache ([#3](https://github.com/AlessioBrillo/dominus/issues/3)) ([c61e383](https://github.com/AlessioBrillo/dominus/commit/c61e383131901c0b848201adc26407269d6c3fbf))
* **trademark:** token-aware match detector and strict USPTO TLD policy ([#9](https://github.com/AlessioBrillo/dominus/issues/9)) ([66fa9b2](https://github.com/AlessioBrillo/dominus/commit/66fa9b29379123e3af5c186062551ccaf58839ff))
* **ui:** add outcome recording form to OutcomesPage ([0430f14](https://github.com/AlessioBrillo/dominus/commit/0430f14f47c649748360c216aa79d5c6ec20cc39))
* **v0.10:** production hardening — scoring fix, RDAP, DNS, recency comps, CI/CD ([09f0ec4](https://github.com/AlessioBrillo/dominus/commit/09f0ec4d32c607bb382b209f19313ed0ce8c9b25))
* v0.5 hardening — architecture diagrams, seed data, AnonScoringService, Docker param, changelog ([d0a0710](https://github.com/AlessioBrillo/dominus/commit/d0a071008ef34f4685412445bb0302ad922bbcf1))
* **watchlist:** add domain watchlist with RDAP polling ([#41](https://github.com/AlessioBrillo/dominus/issues/41)) ([5132b7f](https://github.com/AlessioBrillo/dominus/commit/5132b7f6ed3059b6ad66a667773431e7dc1a2b1c))
* WHOIS port-43 provider with parallel RDAP/WHOIS fallback, TM gate in score command ([#26](https://github.com/AlessioBrillo/dominus/issues/26)) ([45b3e9d](https://github.com/AlessioBrillo/dominus/commit/45b3e9dc5d7e2956b7fa05e989aae492d57f3753))


### Bug Fixes

* 5 production-hardening fixes — submarine confidence, DoT query ID, DNS concurrency, PG bulk pool, stage-level timeout ([#188](https://github.com/AlessioBrillo/dominus/issues/188)) ([e33185a](https://github.com/AlessioBrillo/dominus/commit/e33185a8032052d339178e641295c669b78a58f4))
* 8 production-hardening fixes — pool close, shutdown, auth, scoring, billing ([ace61c1](https://github.com/AlessioBrillo/dominus/commit/ace61c153f4476d545cfca8223fcf5c70f847214))
* **acquisition-funnel:** stabilize pipeline infrastructure ([fabbc0c](https://github.com/AlessioBrillo/dominus/commit/fabbc0cf132c263210fed77d2d207bfbe761dffe))
* **api:** harden public view buffer, anon cache, and unify migration source ([#139](https://github.com/AlessioBrillo/dominus/issues/139)) ([5d99d09](https://github.com/AlessioBrillo/dominus/commit/5d99d098a93b4ef854d377d728bd480764dc4f02))
* **async:** harden async pipeline execution and job queue ([#141](https://github.com/AlessioBrillo/dominus/issues/141)) ([375b304](https://github.com/AlessioBrillo/dominus/commit/375b3049727e69fd17e2f3e94e1526b09eb0ceb1))
* **auth:** correct auth_rate_limits.reset_at column type for PostgreSQL ([#173](https://github.com/AlessioBrillo/dominus/issues/173)) ([7e65a7f](https://github.com/AlessioBrillo/dominus/commit/7e65a7ff1ee4f007a2fc95f58db08bd581dba2a0))
* bridge repair, test coverage, pagination, bump v0.10.0-dev ([#127](https://github.com/AlessioBrillo/dominus/issues/127)) ([bbc8138](https://github.com/AlessioBrillo/dominus/commit/bbc81388f4718b9197775e9031fd3d6f1fb01143))
* **build:** lower coverage thresholds to match current baseline ([0778299](https://github.com/AlessioBrillo/dominus/commit/07782997f3e643babfa218b7485475962940dabf))
* CI pipeline repair — YAML, scoring tests, provider retry refactor, portfolio guards ([#87](https://github.com/AlessioBrillo/dominus/issues/87)) ([1e6140c](https://github.com/AlessioBrillo/dominus/commit/1e6140c854ea4c714320f759a99c970e78819067))
* **ci:** exempt dependabot from CLA check ([#200](https://github.com/AlessioBrillo/dominus/issues/200)) ([e926e3b](https://github.com/AlessioBrillo/dominus/commit/e926e3b4d2fec9178bc3228755123cefb5c5e82f))
* **ci:** repair local CI pipeline ([5d4b3d1](https://github.com/AlessioBrillo/dominus/commit/5d4b3d13cba60c9ff8d999cf09ec59a59d90e64d))
* **cli:** read version from package.json; fix scoring typo ([11d617a](https://github.com/AlessioBrillo/dominus/commit/11d617a8bce751a28e03ff9bdf3f86ad200a275d))
* **compose:** map scheduler env names and externalize db credentials ([#211](https://github.com/AlessioBrillo/dominus/issues/211)) ([5dc049d](https://github.com/AlessioBrillo/dominus/commit/5dc049d48da7c44971465f253a1012d45e051027))
* **config:** align DNS parking and bulk concurrency defaults with docs ([#223](https://github.com/AlessioBrillo/dominus/issues/223)) ([ceefb94](https://github.com/AlessioBrillo/dominus/commit/ceefb94277e0da40a6a981f27599263e8b9d382c))
* critical scoring engine, AbortSignal, auth, and error-handling bugs ([#85](https://github.com/AlessioBrillo/dominus/issues/85)) ([d5d5585](https://github.com/AlessioBrillo/dominus/commit/d5d558555a24e7065a7094bb77dab7fe1abf01f8))
* **db:** add missing await across callers of async DB interface ([#88](https://github.com/AlessioBrillo/dominus/issues/88)) ([6a27e08](https://github.com/AlessioBrillo/dominus/commit/6a27e08abe30bb9dd1b3624261652dc89baa1a2d))
* **db:** add missing tenant_id to listing_offers table and repository ([#140](https://github.com/AlessioBrillo/dominus/issues/140)) ([50b36c5](https://github.com/AlessioBrillo/dominus/commit/50b36c52b2c6dcc83e311013f3a40834486a8fc2))
* **db:** normalize timestamp format for cross-dialect SQL compatibility ([#122](https://github.com/AlessioBrillo/dominus/issues/122)) ([00566d4](https://github.com/AlessioBrillo/dominus/commit/00566d4d6a13016f9f57669c1ac9ad470154ccf2))
* **deps:** bump ip-address 10.4.0 and override uuid 11.1.1 ([dd96974](https://github.com/AlessioBrillo/dominus/commit/dd969741c50ae7e8493bbc54f1597bc109057fc8)), closes [#16](https://github.com/AlessioBrillo/dominus/issues/16) [#26](https://github.com/AlessioBrillo/dominus/issues/26)
* **dns:** bound dot pool queue and dispose pools on shutdown ([#210](https://github.com/AlessioBrillo/dominus/issues/210)) ([5d60c89](https://github.com/AlessioBrillo/dominus/commit/5d60c895e2313121063e38cb0b2a66f215f9a9fd))
* **dns:** closeout CSV candidates now pass through DNS with forceRecheck ([#177](https://github.com/AlessioBrillo/dominus/issues/177)) ([73ed028](https://github.com/AlessioBrillo/dominus/commit/73ed0280317b2e01206fb43c131ee8cda469e363))
* **dns:** conservative group decisions, collision-proof DoT IDs, RDAP per-TLD scope ([#205](https://github.com/AlessioBrillo/dominus/issues/205)) ([91cb0b6](https://github.com/AlessioBrillo/dominus/commit/91cb0b64e1c3da65f58677e6b198426803e9ba64))
* **dns:** handle generic fetch errors in DoH phase, add doh-only tests ([f5f3f4c](https://github.com/AlessioBrillo/dominus/commit/f5f3f4cc70d313df615ef3c671e389072075d0e4))
* **dns:** honor cache disable semantics and never persist unknown ([#209](https://github.com/AlessioBrillo/dominus/issues/209)) ([25ea824](https://github.com/AlessioBrillo/dominus/commit/25ea824ecd1659b25c2f14ebd7dc29112761789e))
* **dns:** randomize DoT query ID to prevent DNS spoofing ([#185](https://github.com/AlessioBrillo/dominus/issues/185)) ([e8fa26f](https://github.com/AlessioBrillo/dominus/commit/e8fa26fcbcb12a731f5c222396f491372684f9e1))
* **dns:** re-check stale Available rows from the persistent cache ([b95b726](https://github.com/AlessioBrillo/dominus/commit/b95b726a3a7e996a3a963f3369236a2937553a3f))
* **dns:** reject late queries after dot pool close with ECLOSED ([#227](https://github.com/AlessioBrillo/dominus/issues/227)) ([a5ad656](https://github.com/AlessioBrillo/dominus/commit/a5ad6565d9e63aa4f4aa9953ff27f42a42cc4043))
* **dns:** restore real native fallback for doh-primary ([#208](https://github.com/AlessioBrillo/dominus/issues/208)) ([7028b98](https://github.com/AlessioBrillo/dominus/commit/7028b986f2e2f39db9359e17705cfad7f0bf35ae))
* **docker:** restore better-sqlite3 binding + CI runtime smoke test ([#207](https://github.com/AlessioBrillo/dominus/issues/207)) ([5c1d3e1](https://github.com/AlessioBrillo/dominus/commit/5c1d3e135c9a888883db61c8d208b475c7a45486))
* **docker:** unignore THIRD-PARTY-NOTICES.md from build context ([003dbb5](https://github.com/AlessioBrillo/dominus/commit/003dbb51683f1d6da70969ea976985f8fb8d0b40)), closes [#196](https://github.com/AlessioBrillo/dominus/issues/196)
* **domain-parsing:** canonical SLD/TLD across scoring + trademark gate (ADR-0013) ([#11](https://github.com/AlessioBrillo/dominus/issues/11)) ([270b674](https://github.com/AlessioBrillo/dominus/commit/270b674cc02f95f01df6d4451a2c80b60d7c819c)), closes [#1](https://github.com/AlessioBrillo/dominus/issues/1)
* **frontend:** resolve pre-existing lint errors blocking CI ([78817df](https://github.com/AlessioBrillo/dominus/commit/78817df215c40db97267465194cbcce2d9716ece))
* **frontend:** update tests to match redesigned shadcn/ui components ([a7d23b9](https://github.com/AlessioBrillo/dominus/commit/a7d23b9937cd5501b8443fa115f8e09328b8d70e))
* harden portfolio rescore, rate-limiter, dns fallback, and scoring config ([#54](https://github.com/AlessioBrillo/dominus/issues/54)) ([a0a62b8](https://github.com/AlessioBrillo/dominus/commit/a0a62b8be77bdee94ee06455455379d27996cff9))
* **infra:** add local CI gate, Docker frontend, bidRange scoring, frontend tests ([7b83476](https://github.com/AlessioBrillo/dominus/commit/7b8347627afe309330ef3f4fbd10467c0e81e3c1))
* **infra:** graceful shutdown, TM circuit breaker, file-based API keys, frontend auth gate ([#51](https://github.com/AlessioBrillo/dominus/issues/51)) ([8fe82d6](https://github.com/AlessioBrillo/dominus/commit/8fe82d6b00a670817979d3518033c38c7f71301e))
* **infra:** harden EUIPO URL, RDAP cross-val, quota persistence ([#53](https://github.com/AlessioBrillo/dominus/issues/53)) ([34fa5e8](https://github.com/AlessioBrillo/dominus/commit/34fa5e8e306bcef957b78ef7cc0666c5cd94f6cd))
* **infra:** harden pipeline, scoring confidence, pronounceability, and migrations ([#52](https://github.com/AlessioBrillo/dominus/issues/52)) ([16a8817](https://github.com/AlessioBrillo/dominus/commit/16a88177edf9a7447b6a53b9185450126ec00e22))
* **infra:** harden SPA routing, add request timeout, parallelize pipeline stages ([#50](https://github.com/AlessioBrillo/dominus/issues/50)) ([fdf372a](https://github.com/AlessioBrillo/dominus/commit/fdf372aab08a9f754005d8206c61a743019746cb))
* **infra:** pipeline hardening - DoH, RDAP, signal, batches ([#156](https://github.com/AlessioBrillo/dominus/issues/156)) ([94e96a8](https://github.com/AlessioBrillo/dominus/commit/94e96a8abdaea0fb3260ca05cacee4e1ca601fc9))
* **infra:** pipeline reliability hardening — timeout, retry, coalescing, retention ([#55](https://github.com/AlessioBrillo/dominus/issues/55)) ([78ab6fb](https://github.com/AlessioBrillo/dominus/commit/78ab6fb6ada68e85ebbdf4d449d3c3e8132d9690))
* **infra:** production hardening — RDAP rate limiters, USPTO degrade, WHOIS cache ([#153](https://github.com/AlessioBrillo/dominus/issues/153)) ([a476b94](https://github.com/AlessioBrillo/dominus/commit/a476b948ae40f3ea8388e3ef3b61ee9343d29de3)), closes [#149](https://github.com/AlessioBrillo/dominus/issues/149) [#150](https://github.com/AlessioBrillo/dominus/issues/150)
* **infra:** resolve confidence display bug, scheduler race, add frontend testing and linting ([ca32b50](https://github.com/AlessioBrillo/dominus/commit/ca32b50b6bd8680b211a7119018342ea4502d8a1))
* **jobs:** harden job-queue concurrency for multi-worker Postgres ([#170](https://github.com/AlessioBrillo/dominus/issues/170)) ([25e97ae](https://github.com/AlessioBrillo/dominus/commit/25e97aead875dc39ff72460713da4adf12ee1ac0))
* **k8s:** harden deployment for read-only rootfs and RWO volume ([#218](https://github.com/AlessioBrillo/dominus/issues/218)) ([d0a2613](https://github.com/AlessioBrillo/dominus/commit/d0a26136d53a8e5de30867fb1b5093fd45d25a30))
* lower coverage thresholds to match current baseline ([8f6ffb8](https://github.com/AlessioBrillo/dominus/commit/8f6ffb8a1d57ef277d05cf193469bf9df6ae0b5d))
* **pipeline:** abort on external signal race and TOCTOU tenant check ([#186](https://github.com/AlessioBrillo/dominus/issues/186)) ([fd226c7](https://github.com/AlessioBrillo/dominus/commit/fd226c773149aff19d7df49f13ac893dbb8f0d26))
* **pipeline:** consistent runId across enqueue to run lifecycle ([#71](https://github.com/AlessioBrillo/dominus/issues/71)) ([de4ee44](https://github.com/AlessioBrillo/dominus/commit/de4ee4464fbb40c6c72acd6a40ff57a9212d23fc))
* **pipeline:** pass externalRunId through orchestrator, fix integration mock ([#97](https://github.com/AlessioBrillo/dominus/issues/97)) ([663b85b](https://github.com/AlessioBrillo/dominus/commit/663b85b0e6ddaf878ff295656fc2f22a448a6b47))
* **pipeline:** promote WHOIS failure log from debug to warn ([4b7b90a](https://github.com/AlessioBrillo/dominus/commit/4b7b90a0f3375d1f345c738386d94324136f4d5d))
* **pipeline:** remove non-null assertions in RDAP and WHOIS batch error recovery ([e52fbca](https://github.com/AlessioBrillo/dominus/commit/e52fbcaf88d9b1fc7391b7dd8aca5e4c98acce35))
* **portfolio:** compute renewal days on calendar days, not 24h deltas ([#219](https://github.com/AlessioBrillo/dominus/issues/219)) ([45fa7aa](https://github.com/AlessioBrillo/dominus/commit/45fa7aa53a5595d0ba4e9f0b770f100f56b904ba))
* **portfolio:** remove vitest import from production rescore service ([#8](https://github.com/AlessioBrillo/dominus/issues/8)) ([dd1eafb](https://github.com/AlessioBrillo/dominus/commit/dd1eafbd4879d444beeea7e7a9ff80766d9c5dd1))
* **prod:** atomic usage enforcement, durable webhook idempotency, 3-tier billing ([#190](https://github.com/AlessioBrillo/dominus/issues/190)) ([baa0e34](https://github.com/AlessioBrillo/dominus/commit/baa0e3401b2f996ebab2a540e4c77709f5edec55))
* production-harden pipeline locks, CSP, DNS, and provider types ([5cb4c73](https://github.com/AlessioBrillo/dominus/commit/5cb4c73d5babf81e60ae662e3c1c0b80244f32e6))
* **provider/euipo:** migrate to Trademark Search 1.1.0 (ADR-0014) ([#16](https://github.com/AlessioBrillo/dominus/issues/16)) ([48816cc](https://github.com/AlessioBrillo/dominus/commit/48816cc767c1d7bdf72a396b420308735ce413a9))
* **public:** gate suggestedBuyMax behind trademark clearance ([#206](https://github.com/AlessioBrillo/dominus/issues/206)) ([74d2e1d](https://github.com/AlessioBrillo/dominus/commit/74d2e1d10468818ff20f19f8b3e81e657e00a0d7))
* **public:** make canonical site URL configurable via PUBLIC_APP_URL ([#239](https://github.com/AlessioBrillo/dominus/issues/239)) ([9ce8dc0](https://github.com/AlessioBrillo/dominus/commit/9ce8dc04005716a6d9aebaaa02d8b61006841a43))
* **public:** strip buy-max when trademark not clear; dedup and cache ([#234](https://github.com/AlessioBrillo/dominus/issues/234)) ([96f822a](https://github.com/AlessioBrillo/dominus/commit/96f822a28348d90499d39a0d337a8955f8676668))
* RDAP/WHOIS conservatism, AbortSignal leak, DNS cache bound, health check, persistence locking ([55fe300](https://github.com/AlessioBrillo/dominus/commit/55fe30098b2b66231c4413d65523c5b7eb74cf4c))
* **rdap:** authoritative per-TLD bootstrap resolution ([#198](https://github.com/AlessioBrillo/dominus/issues/198)) ([1a579ff](https://github.com/AlessioBrillo/dominus/commit/1a579fff7d6cf70da868b3a48579c87739d4ad81))
* **rdap:** never persist unknown results in provider cache ([#226](https://github.com/AlessioBrillo/dominus/issues/226)) ([d9025e1](https://github.com/AlessioBrillo/dominus/commit/d9025e13ca62b28b9e7a171d59a550557ad6ca22))
* **rdap:** share circuit breaker state across containers via Redis ([#221](https://github.com/AlessioBrillo/dominus/issues/221)) ([43c0213](https://github.com/AlessioBrillo/dominus/commit/43c0213632d28d41f95a626fc8a6228548569d8a))
* **redis:** bound rate limiter polling with a wait budget and fail fast ([#222](https://github.com/AlessioBrillo/dominus/issues/222)) ([f7d9be4](https://github.com/AlessioBrillo/dominus/commit/f7d9be42177d9263b895523095912dbe78cdabee))
* **redis:** CompositeLockProvider split-brain fix + DistributedCircuitBreaker + graceful shutdown ([#167](https://github.com/AlessioBrillo/dominus/issues/167)) ([885b371](https://github.com/AlessioBrillo/dominus/commit/885b3716a536c7a3efaf8b748bcbbc1e0c63cd32))
* **reliability:** wire portfolio healthcheck, honor DNS cache TTL, opt-in DNS consensus ([#171](https://github.com/AlessioBrillo/dominus/issues/171)) ([4dc6e98](https://github.com/AlessioBrillo/dominus/commit/4dc6e98248cf45803200f970fe7c96ed62020ee7))
* remove hardcoded CORS * from public-router, rely on global CORS middleware ([a6438b6](https://github.com/AlessioBrillo/dominus/commit/a6438b6a5faa5dd03d92516611f2a357df7a5f9f)), closes [#8](https://github.com/AlessioBrillo/dominus/issues/8)
* resolve 5 CodeQL code scanning alerts ([#116](https://github.com/AlessioBrillo/dominus/issues/116)) ([497a1c1](https://github.com/AlessioBrillo/dominus/commit/497a1c14d6c06212b5b3576b36f7ebd05c66ec8c))
* resolve type errors, ESLint compat, DNS unknown handling ([81159fe](https://github.com/AlessioBrillo/dominus/commit/81159fe907d2f96034ae4ac36bbe7beaad176318))
* resolve typecheck errors from infra hardening changes ([04abd9f](https://github.com/AlessioBrillo/dominus/commit/04abd9fa924e6f42ce97878989028c7f34b89b14))
* **scheduler:** update import for node-cron v4.4.1 type exports ([690b43b](https://github.com/AlessioBrillo/dominus/commit/690b43b9b89b3a4c8caefe917359a64882623146))
* schema divergence, DNS hardening, scoring confidence, security, pipeline observability ([#124](https://github.com/AlessioBrillo/dominus/issues/124)) ([c45fdc2](https://github.com/AlessioBrillo/dominus/commit/c45fdc2e18b81599a9d5d3f7fe1cc91ca4fc147b))
* **scoring:** confidence threshold, weighted formula, and renewal cost penalty ([#44](https://github.com/AlessioBrillo/dominus/issues/44)) ([c091242](https://github.com/AlessioBrillo/dominus/commit/c0912429b3819f37d0123b108024f2ac21c2d796))
* **scoring:** conservative confidence formula, extract WEIGHT_RECOMMEND_THRESHOLD, accept ADR-0015 ([#29](https://github.com/AlessioBrillo/dominus/issues/29)) ([a125447](https://github.com/AlessioBrillo/dominus/commit/a125447c28b4de13d13b1f4e957559c3129d0d1b))
* **scoring:** isolate raw SQL queries by tenant_id ([#123](https://github.com/AlessioBrillo/dominus/issues/123)) ([72662e6](https://github.com/AlessioBrillo/dominus/commit/72662e665a1bae976c12aed8bb9eee6d1a01ad76))
* **scoring:** reduce LIST_PRICE_MULTIPLIER, make WEIGHT_RECOMMEND_THRESHOLD env-configurable ([#30](https://github.com/AlessioBrillo/dominus/issues/30)) ([862512a](https://github.com/AlessioBrillo/dominus/commit/862512a972716ac8f0e5c88069cc72646c73a137))
* **scoring:** sort by date for recencyFactor, not by price ([#187](https://github.com/AlessioBrillo/dominus/issues/187)) ([3e4869f](https://github.com/AlessioBrillo/dominus/commit/3e4869f0be5b8b554dd398e29e3e4b4c09277b82))
* **test:** update health command CLI output regex to match v0.4.0-dev ([a0b8def](https://github.com/AlessioBrillo/dominus/commit/a0b8def5752d71cc82db193fd717e51e47a2914a))
* use canonical SLD in scoring signals, skip null scoreResult persist ([#23](https://github.com/AlessioBrillo/dominus/issues/23)) ([91c793a](https://github.com/AlessioBrillo/dominus/commit/91c793a2b656ab15852712423846680cb7193476))

## [0.5.0-dev] — 2026-06-26

### Added
- ADR-0031: Production hardening — CSP, rate limiting, retry consolidation
- Benchmark suite (vitest bench): pipeline throughput and DNS bulk lookups
- `npm run bench` script for performance regression testing
- Per-token rate limiting on authenticated API routes
- `withRetryAndCircuitBreaker()` utility combining retry + circuit breaker
- `DnsProvider` interface extracted to own file (`dns-provider.ts`)
- `CircuitBreaker.cooldownMs` getter

### Changed
- CSP: removed `'unsafe-inline'` from `script-src` (Vite SPA bundles all scripts)
- AuthProvider built in `createDependencies()` and injected via `DominusDependencies`
- Auth middleware: `isActive` uses typed interface instead of unsafe cast
- Rate limiting split: auth endpoint (30 req/60s) separate from global API (100 req/15min)
- Circuit breaker moved from `src/app/` to `src/providers/` (cross-cutting pattern)
- `RetryingWhoisProvider`, `RetryingTrademarkProvider`, `RetryingRdapProvider`: delegated to `withRetryAndCircuitBreaker()`, removing ~50 lines of duplicate retry loop each
- `NodeDnsProvider`: config injected via constructor options instead of `loadConfig()` at runtime
- `NodeDnsProvider`: `name` property for observability
- eslint config: allow `.bench.ts` files to import vitest
- ROADMAP.md: updated with accurate release status through v0.9.0

### Removed
- Duplicate `RetryPolicy` interface from `retryable-provider.ts` (now imports from `retry-policy.ts`)
- `loadConfig()` calls from `NodeDnsProvider.checkAvailability()` and `checkBulk()`

## [0.4.0] — 2026-06-18

### Added
- ADR-0025: License change — MIT to AGPL v3 + Commercial
- ADR-0026: Monetization and SaaS model — DOMINUS Community vs DOMINUS Cloud
- ADR-0027: SaaS architecture — multi-tenancy, PostgreSQL, authentication
- ADR-0028: Frontend architecture — professional SaaS dashboard
- CONTRIBUTING.md: CLA requirement, dual-backend guidance (SQLite + PostgreSQL)
- GOVERNANCE.md: License section, DOMINUS Cloud section, CLA requirement
- ROADMAP.md with planned releases and feature timeline
- Architecture diagrams (Mermaid) documenting pipeline, provider abstraction, and SaaS architecture

### Changed
- License from MIT to AGPL v3 (v0.4.0+). Existing MIT releases (v0.1.0–v0.3.0) remain MIT.
- README.md: SaaS positioning, editions comparison table, architecture diagram, updated badges, 18 CLI commands
- CLAUDE.md: Updated for SaaS era with ADR-0025 through ADR-0028 references
- SECURITY.md: Added DOMINUS Cloud security design (JWT, RLS, bcrypt API keys)
- SUPPORT.md: Edition-aware support channels, DOMINUS Cloud support for paid plans
- ADR-0001: Status updated to Superseded (see ADR-0026, ADR-0027)
- ADR-0018: Status updated to Superseded (see ADR-0025, ADR-0026)
- Architecture-guardian skill: Updated for multi-tenant and PostgreSQL context
- package.json: License field → AGPL-3.0-only, added "files" field, version → 0.4.0-dev

## [0.3.0] — 2026-06-16

### Added
- Job queue and worker pool architecture (ADR-0023)
- Portfolio P&L tracking and analytics (ADR-0024)
- Listing manager with marketplace integrations (Dan.com)
- Bid management service
- Acquisition tracking service
- Portfolio report service
- Closed-loop auto weight tuning (ADR-0019)
- Provider resilience layer: circuit breakers, retry with jitter, failover providers
- Provider health check and status reporting
- Desktop, Telegram, and Webhook notifiers
- Watchlist with RDAP polling and availability notifications
- Scheduler service with configurable cron jobs
- Backup service with retention policy (ADR-0022)
- Rate-limited token buckets for USPTO, EUIPO, RDAP, WHOIS
- 723 test files across 36 test directories

### Changed
- Pipeline execution is async by default (enqueue to job_queue, worker polls)
- All provider interfaces hardened with timeout, retry, and circuit-breaker decorators
- Enhanced ScoringEngine with configurable confidence formula (ADR-0020)
- Improved error handling throughout with typed DominusError hierarchy

## [0.2.0] — 2026-06-08

### Added
- ADR-0001 through ADR-0006 documenting foundational architecture decisions
- Dockerfile and docker-compose.yml for containerised deployment
- `dominus health` CLI command for system health checks
- SECURITY.md with vulnerability reporting policy
- CONTRIBUTING.md with development workflow guide
- CHANGELOG.md (this file)

### Changed
- Bumped version from 0.1.0 to 0.2.0
- Updated CLAUDE.md and README.md to reflect production-ready state
- All ADR references updated to point to ADR series instead of gitignored
  `dominus-product-vision.md`
- CI workflow to upgrade GitHub Actions runners ahead of Node.js 24 migration

### Removed
- `dominus-product-vision.md` from .gitignore (content extracted into ADRs)
- All references to `dominus-product-vision.md` across documentation and skills

## [0.1.0] — 2026-06-06

### Added
- Five-stage pipeline: candidate generation, DNS pre-filter, RDAP confirmation,
  scoring engine, trademark gate
- Heuristic scoring engine with 4 signals (intrinsic, commercial, market, expiry)
- Real USPTO and EUIPO trademark providers with caching and retry
- Portfolio manager with CRUD, rescore, and drop verdict engine
- Outcomes tracking (sold, dropped, expired, renewed)
- Backtest engine with point-in-time correctness, MAE/bias/calibration reports
- Weight suggester with two-gate activation (suggest → manually approve)
- CLI with 8 commands (run, score, portfolio, candidates, outcome, backtest,
  runs, maintenance)
- REST API with 8 route modules (health, candidates, score, portfolio, outcomes,
  backtest, runs, providers)
- SQLite persistence with 8 migrations (WAL mode, parameterised queries)
- Token-aware trademark matching with Levenshtein distance (ADR-0012)
- EUIPO provider migration to Trademark Search 1.1.0 (ADR-0014)
- Public Suffix List integration via `psl` package (ADR-0015)
- Provider abstraction pattern with 6 interfaces, caching and retry decorators
- CI pipeline via GitHub Actions (typecheck, build, lint, test)
- 414 tests across 56 test files (80% line coverage)
