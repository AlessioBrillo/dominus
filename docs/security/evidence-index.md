# Evidence index — what proves what

A launch claim is worth the artifact behind it. This page is the map: one
row per claim, the command that produces the evidence, where the artifact
lives, and whether it is public, private or git-ignored.

It exists because evidence has a failure mode of its own: a green CI run
that expires, a screenshot with no command, a report in somebody's inbox.
The rule is the one in [ADR-0100](../adr/0100-launch-gate-profiles-and-evidence.md):

> An artifact without the command that produced it is a screenshot, and a
> screenshot is not evidence.

The launch gate writes evidence itself when it is given `--evidence`:

```bash
npm run launch:check -- --community --evidence .acceptance/launch
npm run launch:check -- --cloud --url https://staging.example.com \
  --evidence .acceptance/staging
```

The files are named `launch-evidence-<version>-<commit>.json` and `.md`.
They are written on pass **and** on fail: a failed rehearsal is the most
useful artifact it produces. Secrets are never echoed — the checks record
"is set", not the value.

---

## 1. The index

| Claim | Command that proves it | Artifact | Location | Visibility |
|---|---|---|---|---|
| the repository is internally consistent | `npm run gate` | exit code, CI log | Woodpecker (or `ci-local`) | public |
| the Docker topology builds and boots | `npm run gate:docker` | exit code | Woodpecker `docker` step | public |
| the community edition is launchable | `npm run launch:check -- --community --evidence .acceptance/launch` | `launch-evidence-*.json` / `.md` | `.acceptance/launch/` | git-ignored |
| the Cloud edition is launchable | `npm run launch:check -- --cloud --url … --evidence …` | `launch-evidence-*.json` / `.md` | `.acceptance/staging/` | git-ignored |
| the production-parity Cloud stack runs | `npm run launch:rehearse` | `rehearsal-*.json` / `.md` + `.acceptance/report.json` | `.acceptance/launch/` | git-ignored |
| the paid preconditions are met | `npm run launch:check -- --cloud --url … --paid` | `launch-evidence-*.json` / `.md` | `.acceptance/production/` | attached to the release |
| the published artifact installs and runs | `npm run release:verify -- --pack` | exit code + the installed command | local gate | public |
| the GitHub Release is complete | the `verify-github-release` job | workflow log + asset list | the release page | public |
| the npm package is published with provenance | the `verify` job | registry metadata | npm | public |
| the trademark source answers | `npm run check:trademarks` | verdict for `nike` / `vintagecoffee` | daily workflow + release log | public |
| the legal surface is published | `GET /public/legal` | the live response | the deployment | public |
| the operator identity is real | `npm run launch:check -- --cloud --url …` | gate evidence | `.acceptance/staging/` | private |
| the restore drill restores data | `scripts/restore-drill.mjs --pg-restore …` | command output: recovery time, row counts | operations log | private |
| the backups are off-host | `rclone lsf b2:<bucket>/base/` | object list + timestamps | B2 | private |
| the external probe measures availability | the probe dashboard | uptime history | the probe vendor | private |
| alerting reaches a human | a test alert and its acknowledgement | timestamp + screenshot of the message | operations log | private |
| Stripe tax and SCA behave | the three scenarios in [billing-tax-verification.md](../releases/billing-tax-verification.md) | the completed table | that document | private |
| OIDC login and the seat boundary | the manual smoke in [first-apply.md](../deployment/first-apply.md#85-the-oidc-login) | timestamp + outcome | operations log | private |
| a third party reviewed the security | the audit engagement | report | `docs/security/` | private (summary public) |
| the fiscal position exists | the accountant's advice and the registration | private documents | the operator's records | private |
| the legal texts were reviewed | the lawyer's sign-off | private documents | the operator's records | private |

"Public" means it can be attached to a release without redaction.
"Private" means it is evidence for the operator and the auditor, not for
the announcement. "Git-ignored" means the artifact is generated locally
and must be copied somewhere durable before the machine is wiped.

---

## 2. Generating each artifact

### The gate

```bash
# Community, from a clean checkout.
npm run launch:check -- --community --evidence .acceptance/launch

# A live deployment.
node --env-file="$HOME/.dominus/staging.env" \
  scripts/launch-check.mjs --cloud \
  --url https://staging.example.com \
  --evidence .acceptance/staging

# The paid bar. Fails on a missing audit, Stripe, probe or backup.
node --env-file="$HOME/.dominus/production.env" \
  scripts/launch-check.mjs --cloud \
  --url https://dominus.example --paid \
  --evidence .acceptance/production
```

The JSON is the machine-readable record; the Markdown is the table a
release attaches. Both carry the version, the commit, the platform, the
Node version, every check with its duration, and the summary.

### The rehearsal

```bash
npm run launch:rehearse                 # build the stack, gate it, tear down
npm run launch:rehearse -- --skip-build # reuse the images
npm run launch:rehearse -- --keep       # leave the stack up for inspection
npm run launch:rehearse -- --with-pitr \
  --pitr-base <dir> --pitr-wal <dir> \
  --pitr-expect-rows schema_migrations:<n>   # the recovery drill, when a real pair exists
```

The report names what the rehearsal does **not** prove: Hetzner, Let's
Encrypt, B2, the real PITR target, Stripe Tax, the OIDC provider and the
audit. Those are the rows of the index that only staging can fill.

### The acceptance suite

```bash
npm run acceptance:cloud
```

`.acceptance/report.json` is the list of assertions and their results.
The scope and the boundaries are in
[cloud-acceptance.md](../releases/cloud-acceptance.md).

### The restore drill

```bash
# Layout only — runs anywhere.
node scripts/restore-drill.mjs --pg-base /var/backups/dominus/base/<dir>

# The real drill — needs the db host, a base and the WAL archive.
node scripts/restore-drill.mjs --pg-restore \
  --base /var/backups/dominus/base/<dir> \
  --wal  /var/lib/postgresql/17/main/archive \
  --target-time "<UTC timestamp>" \
  --expect-rows <table>:<count>
```

The artifact is the output: the recovery duration, the replay stop
point, and the row counts. Copy it into the operations log with the
timestamp; the number in [rto-rpo.md](../operations/rto-rpo.md) is a
target until this has run.

### The release

```bash
npm run release:doctor
npm run release:verify -- --pack
npm run test:installers
node scripts/release-cut.mjs --dry-run
node scripts/release-cut.mjs --publish
gh release view v1.5.1 --json assets
```

The release-cut engine's `verify-release` and the public-installer checks
are the post-publish half. The local commands are the pre-tag half, and
both are in `npm run gate` plus `.woodpecker/ci.yml`.

---

## 3. Retention and publication

| Artifact | Keep for | Where |
|---|---|---|
| gate evidence (JSON + MD) | the life of the release | attach to the GitHub Release, or the operations archive |
| rehearsal report | until the next release | `.acceptance/` locally, copied to the archive |
| acceptance report | the life of the release | CI artifact + the operational archive |
| restore-drill output | the life of the deployment | operations log |
| audit report | the life of the company | `docs/security/` (private), summary public |
| Stripe matrix | the life of the tax position | the document, private |
| probe history | 13 months | the probe vendor |

Before attaching anything to a release:

1. open the JSON and search for `password`, `secret`, `token`, `whsec_`,
   `sk_live`, `sk_test`, `BEGIN PRIVATE KEY`;
2. confirm the deployment URL is one you are willing to publish (a
   staging URL is usually fine; an internal hostname is not);
3. confirm the report names no customer and no tenant;
4. prefer the `.md` table for the release body and keep the `.json` as
   the attachment.

The gate does not print secret values, but the evidence carries the
**detail strings** of failed checks, and a misconfigured deployment can
put a hostname in one. The review above is not optional.

---

## 4. The current state — 2026-11-02

| Artifact | State |
|---|---|
| `npm run gate` | not yet run on this branch at the time this file was written |
| `npm run gate:docker` | not yet run on this branch |
| community gate | passes: 12 checks, 0 failed, 5 warnings (development shell) |
| Cloud gate with fixture env | passes: 13 checks, 0 failed, 5 warnings |
| rehearsal | running for the first time; the result is recorded in `.acceptance/launch/` |
| acceptance suite | previously green on v1.3.4; the Cloud topology has run |
| restore drill | never run against a real PostgreSQL; this Windows host has no `psql`/`pg_ctl` |
| staging | does not exist |
| production | does not exist |
| audit | not started |
| fiscal position | not started |
| operator identity | not set |

The honest summary: **the application is rehearsed, the infrastructure
and the contracts are not.** The rows that only staging can fill are the
work list of [first-apply.md](../deployment/first-apply.md), and the
rows that only a human can fill are the work list of
[launch-checklist.md](../releases/launch-checklist.md).

---

## 5. A template for the release attachment

```markdown
## Launch evidence — v1.4.0 (abc1234)

- Gate: PASS — 12 checks, 0 failed, 5 warnings
- Mode: community
- Rehearsal: PASS — acceptance 28/28, PITR skipped (needs a real base/WAL)
- Generated: 2026-11-02T12:00:00Z

The warnings are the known post-launch work: no external probe (no SLA in
the community edition), no Alertmanager webhook (compose-only deployment),
no job notification webhook. They are listed in the attached JSON with
the command that produced them.

Attachments:
- launch-evidence-1.4.0-abc1234.json
- launch-evidence-1.4.0-abc1234.md
- rehearsal-1.4.0-abc1234.md
```

The template is deliberately short. A release note that claims more than
the artifacts prove is the failure this index exists to prevent.
