# ADR-0036: License and IP Protection Hardening

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-01 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0025, ADR-0026, ADR-0018 |
| **Project** | DOMINUS |

## Context

DOMINUS is dual-licensed: AGPL v3 for the open-source community edition and
a proprietary commercial license for organisations that cannot or will not
comply with AGPL terms (ADR-0025). The commercial channel is the project's
monetisation path (ADR-0026). For the dual-licensing model to be legally
sound and defensible, the intellectual-property (IP) foundation must be
consistent and enforceable.

An audit of the licensing surface found several inconsistencies and gaps:

1. **License version mismatch**: the copyright notice appended to `LICENSE`
   says "AGPL v3... or (at your option) any later version", while
   `package.json` declares `"license": "AGPL-3.0-only"` and `CLA.md` grants
   "AGPL v3 (or any later version)". If the FSF ever published an AGPL-4,
   the notice text would relicense the project automatically while the SPDX
   declaration contradicts it — an exploitable ambiguity.

2. **Frontend undeclared**: `frontend/package.json` had no `license` field,
   leaving the frontend (a shipped component of the product) with no
   declared license.

3. **CLA without enforcement**: the CLA (required for the project to
   relicense external contributions commercially) is submitted by email or
   PR comment with no automated gate. A merged contribution without a signed
   CLA permanently removes the project's right to sell that code under the
   commercial license — the one scenario that genuinely "steals" the value
   of the work.

4. **No dependency license gate**: a future GPL-2.0/3.0-only dependency is
   compatible with AGPL but can never be re-licensed commercially — it would
   poison the commercial distribution. There was no CI check preventing
   this.

5. **No third-party notices**: runtime dependencies include Apache-2.0
   components (which require notice preservation, §4d) and `sharp` bundles
   libvips under LGPL-3.0-or-later (which requires license notice and
   replacement capability).

6. **Unclear data provenance**: seed data files were tracked in git under
   `data/` even though `data/` is gitignored for user data. Google Keyword
   Planner data (if ever real) cannot be redistributed under Google Ads
   Terms; NameBio data requires attribution. The committed files are
   synthetic samples, but the policy was undocumented.

7. **No trademark policy**: AGPL protects the code, not the name. Nothing
   states the "DOMINUS" trademark policy or the fork-rename expectation.

## Decision Drivers

1. **Commercial re-licensability is the core asset** — every external
   contribution must carry an enforceable CLA, and no dependency may be
   added that cannot be re-licensed commercially.
2. **Legal consistency** — one license version declared consistently across
   LICENSE, package.json, CLA.md, frontend, and Docker images.
3. **Automated enforcement** — gates must run in CI; a solo maintainer
   cannot rely on manual review.
4. **Zero-cost** — all measures are CI workflows, docs, and metadata; no
   paid tooling.
5. **Redistribution safety** — the repo must never contain data that cannot
   be legally redistributed.

## Considered Options

### Option A: AGPL-3.0-or-later everywhere

Align all declarations to "AGPL v3 or any later version" (the current
`LICENSE` notice text), SPDX `AGPL-3.0-or-later`.

**Advantages:**
- No change to the license text; automatic adoption of future AGPL versions
- Simple migration (package.json, CLA.md, frontend)

**Disadvantages:**
- Relicensing control is ceded to the FSF: an AGPL-4 would apply
  automatically, potentially changing commercial terms for existing
  licensees
- Contradicts the existing `package.json` declaration and the CLA intent of
  predictable terms
- Commercial license buyers sign against terms that may silently change

**Cost Implications:** ~0.5h; €0.

**Risk Assessment:** Low technical risk, medium legal-predictability risk.

---

### Option B: AGPL-3.0-only everywhere with automated gates (CHOSEN)

Pin the license to version 3 only across all declarations, add a
dependency-license CI gate with an approved allow-list, enforce the CLA via
a CI workflow, document third-party notices and data provenance, and
publish a trademark policy.

**Advantages:**
- Full control: no future FSF version can alter the terms without an
  explicit project decision
- Matches the existing `package.json` declaration (minimal diff)
- CI gates make the policy self-enforcing for a solo maintainer
- THIRD-PARTY-NOTICES satisfies Apache-2.0 §4(d) and LGPL notice duties

**Disadvantages:**
- Contributors who might prefer "any later version" terms are constrained
  (immaterial in practice for this project)
- Requires maintenance of the allow-list as dependencies evolve

**Cost Implications:** ~6h development (workflows, docs, script); €0.

**Risk Assessment:** Low. The main residual risk (external contributor
merging without CLA) is closed by the CI gate.

---

### Option C: License gate only, no CLA enforcement

Add the dependency allow-list CI check but keep CLA signing as a manual
process.

**Advantages:**
- Smallest diff (~1h)

**Disadvantages:**
- The commercial-relicensing risk from un-CLA'd contributions remains —
  the highest-value risk in the audit
- No mechanism to guarantee CLA before merge

**Cost Implications:** ~1h; €0.

**Risk Assessment:** High for the CLA gap; the audit identified it as the
only scenario that materially devalues the project.

## Decision

**Chosen option: Option B — AGPL-3.0-only everywhere with automated gates.**

The project declares `AGPL-3.0-only` in `package.json`, so Option B is the
consistent reading of the existing intent; Option A would have changed the
license terms to match a notice text that was likely boilerplate. Version-
pinning gives the sole owner control over any future re-licensing — the
same control that the CLA exists to preserve.

The enforcement stack:

- `cla.yml` (workflow): blocks PRs from external contributors until their
  GitHub username appears in the `## CLA Signers` registry of
  `CONTRIBUTORS.md`. Maintainers, collaborators and automation are exempt.
- `license.yml` (workflow) + `license:check` scripts: `license-checker`
  validates every dependency against an allow-list (MIT, ISC, BSD, Apache-
  2.0, BlueOak-1.0.0, 0BSD, LGPL-3.0-or-later) and fails on GPL-2.0/3.0-
  only, SSPL, BUSL, CC-BY-SA, and packages without a license. LGPL is
  allowed because it does not prevent commercial re-licensing of the
  linking application (sharp/libvips is dynamically linked).
- Data policy: synthetic samples live in `examples/` (committed,
  documented); real user data lives in gitignored `data/`; provenance is
  documented in THIRD-PARTY-NOTICES.md. Seed-data defaults in `config.ts`
  point at the committed samples.
- Trademark policy: README states "DOMINUS" is a trademark of AlessioBrillo
  and forks must use a different name. Registration (EUIPO/WIPO) is an
  external follow-up documented in docs/trademark-checklist.md.

## Consequences

### Positive
- Every external contribution is automatically CLA-gated before merge,
  preserving commercial re-licensability
- A dependency that cannot be re-licensed commercially can never enter the
  tree undetected
- License declarations are consistent across LICENSE, package.json,
  frontend, CLA, and Docker images
- Third-party notice obligations (Apache-2.0 §4d, LGPL) are documented in
  one place
- The repo contains only redistributable data, with provenance documented

### Negative
- The dependency allow-list must be reviewed when new dependencies are
  added (minor maintainer overhead)
- The CLA workflow exempts maintainer PRs, relying on the maintainer's own
  copyright ownership — acceptable for a single-maintainer project

### Compliance and Security Implications
- AGPL §4 (conveying copies): Docker images now carry the LICENSE file;
  the npm package already ships LICENSE in `files`
- Google Ads ToS: no Google-derived data is committed; `data/` is
  gitignored and the policy is documented
- LGPL-3.0: notice preserved; sharp remains replaceable (optional, native)
- No secrets: workflows use only built-in GitHub permissions

### Migration and Monitoring Plan
1. Align LICENSE notice, CLA.md, frontend license field to `AGPL-3.0-only`
2. Add CONTRIBUTORS.md registry + cla.yml workflow
3. Add THIRD-PARTY-NOTICES.md, docs/data-sources.md, docs/trademark-checklist.md
4. Add license-checker scripts + license.yml CI workflow
5. Untrack `data/` seed files, repoint config defaults and tests to
   `examples/`
6. Copy LICENSE into Docker images; publish trademark policy in README
7. One-time SPDX header pass over source files (scripted)
8. Validation: the license.yml and cla.yml jobs are required checks on all
   PRs; a PR adding a GPL dependency must fail CI (verified by adding a
   temporary failing case during implementation testing)

### Validation
- CI shows `license:check` and `cla` jobs green on this PR
- A manual test with a disallowed license fails the license job (validated
  during implementation)
- Trademark policy visible in README; checklist available for the owner's
  EUIPO/WIPO filing

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
