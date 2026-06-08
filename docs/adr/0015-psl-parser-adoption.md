# ADR-0015: Adopt full Public Suffix List via `psl` npm Package

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | ADR-0013 (domain parsing — the curated `MULTI_PART_TLDS` set was always intended as an interim solution) |
| **Relates to** | ADR-0013, ADR-0012 |
| **Project** | DOMINUS |

## Context

ADR-0013 consolidated domain parsing into a single `parseDomain` function in `src/utils/domain.ts` backed by a hand-curated `MULTI_PART_TLDS` set of 29 multi-part country-code suffixes (`co.uk`, `com.au`, etc.). The ADR explicitly noted this as an interim measure and marked full Public Suffix List (PSL) adoption as a follow-up in its "Negative Consequences" section.

The curated set has three gaps that grow over time:

1. **Missing ccTLD patterns**: several common multi-part ccTLDs are absent (`ne.kz`, `or.th`, `go.kr`, `ac.nz`, `co.ve`, `com.ec`, `org.mx`, to name a few). The original selection was based on the domain aftermarket categories the author expected to encounter during MVP, but closeout CSV imports are source-agnostic and regularly include names with unlisted suffixes.

2. **Missing new gTLD hybrids**: the new gTLD programme has delegated suffixes with second-level registration policies (e.g., `uk.com`, `eu.com`, `gb.net`). These are not in the curated set, causing incorrect SLD extraction (e.g., `example.uk.com` would be parsed as SLD `exampleuk` over TLD `.com` instead of SLD `example` over TLD `.uk.com`).

3. **Subdomain misclassification**: the curated approach falls through to `parts[0]`-as-SLD for any 3+ label domain whose last-two labels are not in the set — even when the extra labels are ordinary subdomains of a single-label TLD. For `sub.domain.com`, the current parser returns `{ sld: 'sub', tld: '.com' }` when it should return `{ sld: 'domain', tld: '.com' }`. This has not yet surfaced as a visible bug because most pipeline candidates arrive as bare `sld.tld` pairs, but it is silently wrong.

The PSL is maintained by Mozilla, updated continuously, covers ~10,000+ entries, and is the de facto standard for browser-grade domain parsing. The `psl` npm package wraps it with a simple `parse()` API.

### Previous ADR trajectory

- ADR-0012 adopted the curated set for the trademark gate, noting the limitation.
- ADR-0013 consolidated the set into a single exported constant and explicitly made full PSL adoption the follow-up.
- ADR-0015 closes that follow-up.

## Decision Drivers

1. **Correctness** — SLD/TLD extraction must be correct for any domain a closeout CSV or keyword combinator could produce. A curated set that silently misparses unlisted suffixes will eventually produce bad scoring signals and false trademark matches.
2. **Maintenance burden** — the curated set requires manual updates when new TLDs or second-level registration policies are introduced. With ~1,500+ TLDs and thousands of PSL entries, manual curation is not sustainable at single-developer scale.
3. **Library maturity** — the PSL is a low-risk, zero-cost dependency. The `psl` package has 2M+ weekly downloads, stable API, and is dependency-free. Adopting it eliminates the correctness gap without introducing operational risk.
4. **Conservatism principle** (Principle 5) — the scoring engine must be conservative. Incorrect SLD extraction inflates the apparent SLD (e.g., `exampleuk` instead of `example`), which distorts intrinsic signals (length, pronounceability). Full PSL adoption makes the parser *more* conservative, not less.

## Considered Options

### Option A: Adopt `psl` npm Package

Replace the curated `MULTI_PART_TLDS` set with `psl.parse()` for all SLD/TLD extraction. The `ParsedDomain` interface and `parseDomain`/`extractTld`/`extractSld` exports remain unchanged — only the implementation changes.

The `psl` package:
- Bundles the full Mozilla Public Suffix List
- Exports `parse(domain)` → `{ tld, sld, domain, subdomain, error }`
- Zero runtime dependencies, 30KB unpacked
- Handles all edge cases (Punycode, subdomain stripping, unknown TLDs)

**Advantages:**
- Correct for every domain that has a known TLD or PSL entry — no gaps
- Zero maintenance — updates ship with `npm update` when Mozilla publishes revisions
- Eliminates the subdomain misclassification bug (`sub.domain.com` → correct SLD)
- Proven library: 2M+ weekly downloads, backed by Mozilla's PSL
- Same API used by the trademark gate, so both systems agree on SLD extraction

**Disadvantages:**
- Adds one dependency (30KB, zero sub-dependencies)
- Increases parse time marginally for the first call (PSL is loaded into memory) — negligible for DOMINUS volumes
- `psl.parse()` returns `tld` without a leading dot, requiring a `.` prefix to maintain the existing `ParsedDomain` interface

**Cost Implications:** Zero monetary cost. ~30 minutes to implement (install, replace implementation, update tests, remove dead code in trademark module).

**Risk Assessment:** Low. The PSL is a stable, widely-adopted standard. The `psl` package has a single responsibility and no open CVEs. Rollback is trivial (revert commit, restore `MULTI_PART_TLDS`).

---

### Option B: Expand the Curated Set

Keep the current `parseDomain` logic but grow the `MULTI_PART_TLDS` set to cover more suffixes — either by manually adding entries as they're encountered or by importing a PSL-derived list at build time.

**Advantages:**
- No new dependency
- Full control over which suffixes are recognised
- Current code path unchanged — no interface breakage

**Disadvantages:**
- Manual expansion is reactive and error-prone — closeout CSVs from different sources will keep surfacing unlisted suffixes
- The subdomain misclassification bug cannot be fixed without fundamentally changing the algorithm (the fallthrough to `parts[0]` is inherent to the approach)
- Build-time PSL import would require a code-generation step, adding more complexity than just using the library at runtime
- Ongoing maintenance burden falls entirely on the single developer

**Cost Implications:** Zero monetary cost. Ongoing developer time cost for each suffix addition.

**Risk Assessment:** Medium-high. The subdomain bug will eventually cause incorrect scores. Missing suffixes will produce incorrect SLDs that feed into trademark matching and scoring simultaneously — two wrong answers instead of one.

---

### Option C: Write a Minimal PSL Matcher In-House

Implement a Trie-based matcher using the PSL raw data file (`public_suffix_list.dat`), bundled as a resource in the repo.

**Advantages:**
- No external dependency
- Full control over the matching algorithm
- Educational value

**Disadvantages:**
- Significant development and testing effort (estimated 2-3 days for a correct implementation covering all edge cases)
- Ongoing maintenance — must re-download the PSL data file on each release
- Risk of subtle bugs in edge cases (wildcard rules, exception rules, Punycode)
- Reinventing a well-solved wheel — the `psl` package already does this correctly
- No benefit over Option A for the effort invested

**Cost Implications:** Zero monetary cost. ~2-3 days of developer time for initial implementation plus recurring maintenance.

**Risk Assessment:** High. A custom matcher is likely to have edge-case bugs that take months to surface. The `psl` package has been battle-tested by millions of users.

## Decision

**Chosen option: Option A — Adopt `psl` npm Package**

The rationale is straightforward:

1. **Correctness gap is real and growing.** The curated set covers 29 patterns. The PSL covers ~10,000+. Missing even one common suffix (e.g., `uk.com`, which has seen significant domain aftermarket activity) produces wrong SLD extraction in both the scoring engine and the trademark gate — two subsystems whose correctness is critical.

2. **Zero-cost, zero-maintenance.** Adding a 30KB package with no dependencies and 2M+ weekly downloads is a strict improvement over maintaining a hand-curated set. The PSL is updated by Mozilla as new TLDs and registration policies emerge — DOMINUS gets those updates free with `npm update`.

3. **Fixes the subdomain bug.** Option A is the only option that correctly handles `sub.domain.com` → `{ sld: 'domain', tld: '.com' }`. Neither Option B (curated expansion) nor Option C (in-house matcher) addresses the algorithmic fallthrough issue without fundamental redesign. Fixing this bug improves scoring accuracy for any candidate that arrives with subdomain-like formatting — rare in closeout lists but not impossible.

4. **Trademark gate alignment.** Both `domain.ts` and `match-detector.ts` currently duplicate the `MULTI_PART_TLDS` logic. Adopting `psl` in `domain.ts` and having `match-detector.ts` import `extractSld` from `domain.ts` eliminates the duplication entirely — a clean architecture win.

Option B (curated expansion) is rejected because it cannot fix the subdomain bug and creates ongoing maintenance drag. Option C (in-house matcher) is rejected because it duplicates an existing, proven library at a high development cost with higher risk of bugs.

## Consequences

### Positive
- Correct SLD/TLD extraction for every domain with a known PSL entry — eliminates the correctness gap entirely
- Zero-maintenance PSL updates ship with routine `npm update`
- Subdomain misclassification bug (`sub.domain.com` → `{ sld: 'domain', tld: '.com' }`) is fixed
- Duplicated SLD extraction logic in `match-detector.ts` is eliminated — trademark module uses `extractSld` from `domain.ts`
- No API or interface changes anywhere in the codebase — purely an implementation swap

### Negative
- One additional dependency (balanced against the elimination of ~35 lines of curated set + duplicate trademark logic)
- `psl.parse()` returns TLD without leading dot, requiring a `'.' + parsed.tld` transformation in `parseDomain` — minor, consistent with the existing interface
- Test expectations for the "unknown multi-part suffix fallthrough" case change (now correctly handled by PSL)

### Compliance and Security Implications
- PSL is a Mozilla standard with no compliance requirements
- No security implications — the `psl` package does not make network calls or evaluate untrusted input beyond string parsing
- The `psl` package has no known CVEs (checked at time of writing)

### Migration and Monitoring Plan
- **Installation**: `npm install psl` and `npm install -D @types/psl`
- **Code changes**: Replace `MULTI_PART_TLDS` usage in `parseDomain` with `psl.parse()`; remove duplicate `extractSld` from `match-detector.ts` in favour of the `domain.ts` export; update tests to reflect PSL-correct behavior for 3+ label domains
- **Rollback**: Revert the commit — `MULTI_PART_TLDS` and the duplicate trademark logic remain in git history
- **Validation**: Existing `parseDomain` tests must pass (with two updated expectations); trademark gate tests must pass with the imported `extractSld`

### Validation
- All 354 existing tests pass (post-update)
- `parseDomain` test suite confirms: vanilla gTLDs, multi-part ccTLDs, subdomain-only prefixes, empty input, and malformed input all produce the correct result
- Match-detector tests confirm `extractSld` from `domain.ts` produces identical results to the previous trademark-specific implementation for known suffixes

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
