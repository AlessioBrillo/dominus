# Community soft launch — v1.4.0

The community edition is the first public release, and it is a **soft
launch**: publish the artifact, make it installable, open a place to
report problems, and tell a small audience. The paid Cloud is not part of
this step. It stays behind the fiscal position, the third-party audit and
a real staging deployment, none of which the community release needs.

The reason for the order is not caution for its own sake. The community
edition has no multi-tenant boundary, no billing and no customer data:
the failure modes the paid launch is blocked on do not exist in it. It
can ship now, and the feedback from real installations is the cheapest
hardening the Cloud will get.

---

## 1. What "soft" means

| In | Out |
|---|---|
| a versioned GitHub Release with verified assets | a Product Hunt launch |
| a GitHub Discussion for questions and bugs | a paid advertising campaign |
| one short post on a small, relevant community after 48 h | a Show HN on day one |
| the README quickstart verified end to end | a promise of support response times |
| the community launch gate, with evidence attached | any paid-tier claim |
| a public issue tracker | a status page, an SLA, or an uptime figure |

The Cloud landing page may say "managed hosting is coming" and nothing
more. It must not offer a pre-order, a waitlist with a date, or a price
that is not backed by a fiscal position.

---

## 2. Preconditions

### 2.1 Mechanical

- [ ] `npm run gate` is green on the release commit.
- [ ] `npm run gate:docker` is green if compose, Dockerfile or deploy
      files changed.
- [ ] `npm run launch:check -- --community --evidence .acceptance/launch`
      passes, and the evidence is attached to the release.
- [ ] `npm run launch:rehearse` is green (application topology, gate,
      evidence).
- [ ] `npm run release:doctor` reports the tree, the version and the tag
      consistently.
- [ ] `npm run release:verify -- --pack` installs the tarball and runs
      `dominus score vintagecoffee.com`.
- [ ] `npm run test:installers` passes on Linux and Windows.
- [ ] `npm run check:trademarks` is green (`nike` blocked,
      `vintagecoffee` clear).
- [ ] the `release` workflow is green, and its `verify` and
      `verify-github-release` jobs passed.
- [ ] the GitHub Release has: `install.sh`, `install.ps1`,
      `dominus-oss.tgz`, `dominus-oss.tgz.sha256`, the versioned tarball
      and its checksum.
- [ ] the README quickstart works from a clean machine with no checkout:
      the `curl | sh` path and the manual tarball path.
- [ ] GitHub Discussions is enabled (Announcements, Q&A, Ideas) and the
      issue templates are present.

### 2.2 Editorial

- [ ] the README says what the product is, what it is not, and that the
      community edition is free and self-hosted;
- [ ] the README names the GitHub Release as the primary channel and npm
      as best-effort (until the trusted publisher is configured);
- [ ] the limitations are stated: the trademark gate depends on public
      endpoints, the community edition has no SLA, the automation ships
      dark, and the scoring is decision support, not financial advice;
- [ ] `SECURITY.md` names a private disclosure channel;
- [ ] `SUPPORT.md` says what the community can expect (best effort) and
      what it cannot (a response time);
- [ ] `LICENSE` is AGPL-3.0-only and the corresponding-source note is in
      the README;
- [ ] the announcement draft in §5 has been read by one other person, or
      slept on once.

---

## 3. Cut the release

The version bump and the tag are a separate, reviewed commit. The
release workflow is the only thing that publishes.

```bash
# 1. The version is consistent everywhere.
npm version 1.4.0 --no-git-tag-version
# package.json, README badge, CHANGELOG, Terraform example, docker smoke
npm run check:release-consistency

# 2. The gate on the final tree.
npm run gate
npm run gate:docker          # if the diff touches compose/Dockerfile/deploy
npm run launch:rehearse

# 3. Commit, push, open the PR, merge to master.
git add -A
git commit -m "release: v1.4.0 — launch gate profiles, rehearsal, first-apply runbook"
git push -u origin release/1.4.0
gh pr create --base master --title "Release v1.4.0 — First Light" --body-file -

# 4. After the merge, tag the merge commit.
git switch master && git pull
git tag -a v1.4.0 -m "DOMINUS v1.4.0 — First Light"
git push origin v1.4.0

# 5. Watch the release workflow; it publishes and verifies.
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"

# 6. Confirm the artifacts a stranger will download.
gh release view v1.4.0 --json assets \
  --jq '.assets[] | "\(.name) \(.size) bytes"'
```

If the release workflow fails **after** publishing, the artifact is not
un-published: fix forward with a patch release. If it fails before
publishing, the tag can be deleted and re-cut:

```bash
git tag -d v1.4.0
git push origin :refs/tags/v1.4.0
```

Deleting a tag that already has a GitHub Release is a last resort; the
release notes and the asset URLs are already public.

---

## 4. Verify the public channel like a stranger

Run this on a machine that has never seen the repository:

```bash
# Linux/macOS
curl -fsSL https://github.com/AlessioBrillo/dominus/releases/latest/download/install.sh | sh
dominus score vintagecoffee.com

# Windows PowerShell
iwr -useb https://github.com/AlessioBrillo/dominus/releases/latest/download/install.ps1 | iex
dominus score vintagecoffee.com
```

The expected output is the decision profile: a verdict (`clear` or
`blocked`, never `unverified`), a score, a buy ceiling, and the reason.
It must not create a database, start a worker, or write 15 KB of JSON to
stdout.

Then the manual path:

```bash
curl -fLO https://github.com/AlessioBrillo/dominus/releases/latest/download/dominus-oss.tgz
curl -fLO https://github.com/AlessioBrillo/dominus/releases/latest/download/dominus-oss.tgz.sha256
sha256sum -c dominus-oss.tgz.sha256
npm install -g ./dominus-oss.tgz
dominus score vintagecoffee.com
```

And the self-hosted path, because that is the edition the soft launch is
about:

```bash
git clone https://github.com/AlessioBrillo/dominus.git
cd dominus
npm ci && npm run build
API_KEYS="$(openssl rand -hex 32)" docker compose up -d
curl -fsS http://localhost:3000/api/health
```

Record the four outputs (installer, manual, docker, health) in the
release discussion. That post is the evidence that the channel works,
not the workflow log.

---

## 5. The announcement

Short, specific, no superlatives. The audience is domain investors and
self-hosters who will judge the tool by the first command, not by the
copy.

### 5.1 GitHub Discussion (day 0)

Title: **DOMINUS v1.4.0 — open-source domain valuation, now installable in one command**

```markdown
DOMINUS is an open-source decision-support tool for domain investors:
it scores a domain, checks the trademark, and tells you whether the
price leaves a margin. It also tracks a portfolio's renewal clock and
gives keep/drop/reprice verdicts.

v1.4.0 is the first release I am comfortable calling installable:

- one-command install on Linux/macOS and Windows, with a verified
  checksum and no telemetry;
- a decision profile that answers in ~2 s and writes nothing to disk:
  `dominus score vintagecoffee.com`;
- a full self-hosted edition with the 5-stage pipeline, the portfolio
  tracker and the REST API (AGPL-3.0-only);
- a mandatory trademark gate before any buy recommendation — if the
  trademark sources cannot answer, the verdict is "unverified" and the
  tool does not recommend the domain.

What it is not: financial advice, a guarantee of a sale, or a service
with an SLA. The community edition is self-hosted; you own the data and
the backups.

Install:
  curl -fsSL https://github.com/AlessioBrillo/dominus/releases/latest/download/install.sh | sh
  dominus score vintagecoffee.com

The release, the checksums and the source are here:
https://github.com/AlessioBrillo/dominus/releases/tag/v1.4.0

I am looking for two kinds of feedback: a domain where the verdict
looks wrong (with the domain and the output), and an installation that
failed (with the OS and the command). Both go in Issues; everything
else is welcome here.

Managed hosting is not part of this release.
```

### 5.2 The 48-hour check

Before posting anywhere else, verify:

- [ ] no open P0 (install broken, data loss, secret exposure);
- [ ] the installer works on a second clean machine;
- [ ] the trademark canary is still green;
- [ ] at least one stranger has installed it, or the discussion has been
      live long enough that the silence is informative;
- [ ] the release assets still resolve (GitHub can lag).

If a P0 is open, fix it and cut a patch release. Do not amplify a broken
install.

### 5.3 The wider post (day 2–7)

One post, one community, chosen by fit:

| Community | Angle | Do not |
|---|---|---|
| r/selfhosted | self-hosted, no telemetry, SQLite, docker compose | post a landing page |
| r/Domains | the trademark gate and the buy ceiling | astroturf |
| Hacker News (Show HN) | the engineering: the gate, the conservatism, the €0 stack | ask for upvotes |
| Indie Hackers | the build-in-public story | promise a Cloud date |

The post is the Discussion text, adapted to the community's rules, with
the direct release link. One community per day, and answer every reply
for the first week.

---

## 6. Support and triage

| Channel | What it is for | Response |
|---|---|---|
| GitHub Issues | reproducible bugs, installation failures | best effort, triaged weekly |
| GitHub Discussions | questions, ideas, show-and-tell | best effort |
| `SECURITY.md` private channel | vulnerabilities | acknowledged within 3 business days |
| the operator's contact address | legal and privacy requests | as published |

Triage labels: `bug`, `installation`, `provider`, `documentation`,
`security` (private), `wontfix`. A bug that produces a wrong buy
recommendation is `P0` regardless of how rare it looks: the product's
promise is conservatism, not coverage.

The community edition has **no SLA**. The Cloud SLA
([sla.md](../operations/sla.md)) is a paid contract and does not apply to
a self-hosted installation. Say so in the discussion, in the README, and
in the first reply to anyone who asks.

---

## 7. What not to claim

| Don't say | Say instead |
|---|---|
| "production-ready for everyone" | "installable; the community edition is self-hosted and has no SLA" |
| "guaranteed accurate valuations" | "decision support; the scoring is heuristic and every weight is visible" |
| "the trademark check is legally conclusive" | "a mandatory check against public trademark sources; it is not legal advice" |
| "the Cloud is available" | "managed hosting is not part of this release" |
| "audited" | nothing, until the audit report is on file |
| "GDPR compliant" | "the legal surface and the data-rights endpoints are built; the operator's identity and contracts are the operator's" |
| "free forever" for the Cloud | "the community edition is free forever; the Cloud is a separate paid service" |
| "X users" / "X domains scored" | only if the number is measured and the measurement is described |

The README is the source of truth. If the announcement and the README
disagree, the announcement is wrong.

---

## 8. After the launch

### Day 1

- [ ] the release is published and the assets are verified;
- [ ] the Discussion is live and pinned;
- [ ] the four install paths are recorded in the Discussion;
- [ ] the first issues are labeled and answered;
- [ ] the trademark canary is green.

### Day 7

- [ ] count installs from the GitHub Release download API (a proxy, not
      a user count) and issues by label;
- [ ] fix the top installation failure, or document it;
- [ ] cut a patch release if a P0 was found;
- [ ] review the announcement against the README one more time.

### Day 30

- [ ] decide whether the wider launch happens, with the data;
- [ ] close the loop on every issue opened in the first week;
- [ ] if the Cloud is next, the staging runbook and the audit kick-off
      are the next two actions, not a landing page.

The soft launch is successful when a stranger can install the tool, score
a domain, and report a problem without talking to the author. Downloads
are a proxy; the first installation that works on a stranger's machine is
the signal.

---

## 9. Rollback

A community release cannot be recalled once it is downloaded. The
responses, in order:

1. **A broken installer or a bad tarball** — edit the release to mark it
   as a pre-release, publish a fixed patch, and update the Discussion
   with the fixed link. Do not delete the tag: the checksums are already
   public.
2. **A security issue** — publish a GitHub Security Advisory, a patch
   release, and a clear note in the Discussion. If a secret was
   published, rotate it first.
3. **A wrong claim in the announcement** — edit the post and say what
   changed. A silently edited claim is worse than the original mistake.
4. **A dependency or provider outage** — the trademark gate fails closed
   (unverified, no recommendation); say so in the Discussion and let the
   canary tell you when the source is back.

The paid Cloud is not affected by any of these: it is not launched, and
it stays behind its own gate.
