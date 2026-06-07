# ADR-0013: Domain parsing consolidation — canonical SLD/TLD across scoring and trademark gate

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-07 |
| **Authors** | DOMINUS team |
| **Deciders** | DOMINUS team |
| **Supersedes** | N/A |
| **Relates to** | ADR-0012 (trademark matching policy), ADR-0001 (architecture principles §1, §2) |
| **Project** | DOMINUS |

## Context

The trademark gate (ADR-0012) gained token-aware matching and a curated
`MULTI_PART_TLDS` set in the previous cycle. The change was scoped to the
trademark module; the scoring engine was left untouched. Three
consequences followed:

1. **The scoring engine was silently wrong on every ccTLD candidate.**
   `intrinsic-signal.ts` reconstructed the SLD with
   `input.domain.replace(input.tld, '')`. For `nike.co.uk` with
   `tld = '.uk'` (the value `extractTld` in
   `candidate-generation-stage.ts` was returning), the SLD became
   `nike.co` — the length was 7, the dot in the middle perturbed the
   pronounceability signal, and the hyphen/digit counts were applied to
   the wrong token. The engine has been producing wrong intrinsic
   scores for every `.co.uk`, `.com.au`, `.ac.uk`, `.ne.jp`, and the
   rest of the `MULTI_PART_TLDS` set since MVP.
2. **`MULTI_PART_TLDS` lived in two places** (the trademark
   match-detector and the new `utils/domain.ts`). A future change to
   the set — adopting the full Public Suffix List, adding a
   jurisdiction-specific suffix, removing a stale one — could land in
   one file and be forgotten in the other, producing different SLD
   extractions in the scoring engine and the trademark gate.
3. **`extractTld` was duplicated** in `candidate-generation-stage.ts`
   and the CLI `dominus score` command, each with the same naive
   `domain.split('.').pop()` bug.

The bug was silent because `.com` is the dominant TLD in any
candidate list; ccTLDs are a small minority and the bias was on a
single sub-signal. A spot audit (e.g. running `dominus score
nike.co.uk`) would have surfaced the wrong `details.length`, but no
such audit existed.

## Decision Drivers

1. **Single source of truth** — the canonical SLD and TLD for any
   domain must be computed by exactly one function. The scoring
   engine and the trademark gate cannot disagree on what `nike.co.uk`
   is.
2. **Caller is responsible for the SLD** — the scoring engine should
   not recompute the SLD from `domain` and `tld`, because that
   reconstruction is ambiguous for multi-part TLDs. The caller (the
   scoring stage, the portfolio rescore service, the CLI) is the
   place that knows the full domain string and can pass the canonical
   SLD.
3. **No new dependencies** — the project is "no paid API, stdlib
   only" (Principle §8). A full Public Suffix List parser is a future
   hardening, not a current need; the curated set covers 30+ suffixes
   at the cost of a single constant.
4. **Backwards compatible at the data layer** — no migration, no
   schema change. The fix is observable on the next pipeline run; the
   old (wrong) intrinsic scores are not retroactively corrected
   because they were never persisted as authoritative values (the
   portfolio rescore refreshes them).
5. **Drift-resistant** — adding or removing a multi-part suffix
   touches exactly one constant in exactly one file. The match
   detector imports the same constant.

## Considered Options

### Option A: Shared `parseDomain` in `src/utils/domain.ts` (CHOSEN)

A new module exports `parseDomain(raw): { input, sld, tld }` and
two thin wrappers `extractTld`, `extractSld`. The module is the
single source of truth for both the curated `MULTI_PART_TLDS` set
and the SLD/TLD split. The trademark match detector imports the
constant; the scoring engine, the scoring stage, the candidate
generation stage, and the CLI score command all use the wrappers.

**Advantages:**

- One constant, one function. A future change to the multi-part
  list touches one file.
- The function returns a structured object so callers can pass
  `sld` and `tld` independently through their existing types
  (`ScoringInput.sld` becomes a first-class field, replacing the
  fragile `domain.replace(tld)` reconstruction).
- Existing tests for the trademark gate are bit-identical after the
  import swap (the match detector's behaviour is unchanged).
- Backwards compatible: a vanilla `.com` domain still parses the
  same way, and the engine produces the same intrinsic score.

**Disadvantages:**

- `ScoringInput.sld` is a required field; every caller must pass
  it. The compiler catches omissions, so the migration is mechanical
  but it does require touching four call sites (scoring-stage,
  rescore-service, CLI score command, all test fixtures).
- The curated set is a snapshot. New gTLD delegations
  (e.g. `bar.baz.qux`) fall through to the first-label default.
  This is the right trade-off at single-user scale; a future change
  can swap the constant for a parser-fed `Set`.

**Cost Implications:** Trivial. ~150 LOC + tests, no new
dependencies, no schema migration.

**Risk Assessment:** Low. The behaviour change is well-scoped: a
multi-part TLD is now correctly split, and the scoring engine's
intrinsic signal sees the right SLD. Existing tests for `.com`
inputs are bit-identical.

---

### Option B: Inline a Public Suffix List parser in `utils/domain.ts`

Bundle a stripped-down PSL parser (e.g. parse the PSL text file
once at startup) so the engine covers every public suffix on
the planet without manual curation.

**Advantages:**

- Future-proof for new gTLD delegations.
- Operationally honest: the engine handles any ccTLD correctly
  with no manual set maintenance.

**Disadvantages:**

- The PSL is large (~100k entries). Embedding it bloats the
  binary and the test fixtures.
- Parsing correctness is a known hard problem (PSL has
  exceptions like `*.ck`); writing a correct parser in-tree
  is a non-trivial side quest.
- A PSL parser is a third-party concern. Inlining it without a
  battle-tested dependency is the kind of "we own the bug"
  trap the architecture-guardian explicitly warns against.

**Cost Implications:** Moderate to high. ~400 LOC for a correct
parser, or a new dependency that pulls a transitive tree.

**Risk Assessment:** Medium. The benefits accrue to a small
minority of candidates (gTLDs not in the curated set). The
maintenance cost is paid by every pipeline run for the rest of
the project's life.

---

### Option C: Defer the fix, document the limitation

Leave the latent bug in place, add a comment in
`intrinsic-signal.ts` warning callers about multi-part TLDs, and
park the consolidation as a future task.

**Advantages:**

- Zero code change.
- Zero regression risk.

**Disadvantages:**

- The bug is the kind that gets rediscovered six months from now
  when the operator finally runs the pipeline on a UK closeout
  batch and wonders why the SLDs look weird.
- A "documented limitation" with no test pinning it is the
  textbook recipe for the next contributor to reintroduce the
  bug.
- ADR-0012 already called this out as the #1 follow-up; deferring
  it pushes the cost forward with no benefit.

**Cost Implications:** Zero code work; the bias cost is real
and silent (every ccTLD candidate's intrinsic score is wrong).

**Risk Assessment:** High. The bias is exactly the failure mode
Principle 5 (scoring conservatism) exists to prevent: the
engine is wrong on the silent axis.

## Decision

**Chosen option: Option A — shared `parseDomain` in
`src/utils/domain.ts`.**

The single-source-of-truth design closes both the scoring bug
and the drift hazard in one move. The candidate generation
stage and the CLI score command now share the same TLD
extractor as the trademark match detector's SLD extractor; the
scoring engine receives the canonical SLD as a typed
`ScoringInput.sld` field and stops reconstructing it from the
fragile `domain.replace(tld)` formula.

For each decision driver:

- **Driver 1 (single source of truth)** — `parseDomain` is the
  only function that knows about `MULTI_PART_TLDS`. The match
  detector imports the constant; the engine receives a
  pre-computed SLD.
- **Driver 2 (caller computes the SLD)** — `ScoringInput.sld`
  is a required field. The compiler enforces the invariant.
- **Driver 3 (no new dependencies)** — the curated set is a
  `ReadonlySet<string>` literal in the new file. Zero
  dependencies added.
- **Driver 4 (backwards compatible at the data layer)** — no
  schema change, no migration. The fix is observable on the
  next pipeline run; portfolio entries are re-scored
  transparently by `dominus portfolio rescore`.
- **Driver 5 (drift-resistant)** — adding or removing a
  multi-part suffix touches exactly one constant.

## Consequences

### Positive

- **Correct intrinsic scores for every ccTLD candidate.** A
  `.co.uk` closeout is now scored on the 4-letter SLD
  `nike`, not the 7-character `nike.co`. The length,
  pronounceability, hyphen, and digit sub-signals all see the
  right token.
- **No drift between scoring and trademark gate.** Both layers
  use the same `MULTI_PART_TLDS` constant from
  `utils/domain.ts`. A future addition (e.g. `.de` for the
  German patent office, or a full PSL parser) lands in one
  place and both call sites benefit.
- **First-class `ScoringInput.sld`.** The engine no longer
  has to guess the SLD from the TLD. The interface is
  explicit; the type-checker enforces it.
- **CLI parity with pipeline.** `dominus score nike.co.uk` now
  prints the same SLD the pipeline would. Ad-hoc debugging is
  consistent with batch runs.

### Negative

- **Call sites must be updated.** `ScoringInput.sld` is
  required, so every test fixture, the scoring stage, the
  rescore service, and the CLI score command had to be
  updated. This is mechanical and compiler-enforced, but it
  is a real diff (8 files touched in commit 3).
- **Curated multi-part TLD list is a snapshot.** New gTLD
  delegations (e.g. `bar.baz.qux`) fall through to the
  first-label default. This is the right trade-off at
  single-user scale; a future change can swap the constant
  for a parser-fed `Set` without touching the matching logic.
- **Existing portfolio entries retain their (wrong) old
  intrinsic scores until the next rescore.** The fix is
  forward-only; it does not retroactively rewrite history.
  `dominus portfolio rescore` corrects the entries in a single
  pass.

### Compliance and Security Implications

- No new PII, no credentials, no API keys.
- The fix is *defensive*: a previously-silent scoring bias on
  ccTLD candidates is now corrected, aligning the engine with
  Principle 5 (conservatism).
- The TLD extraction has no security implications — it is a
  pure string transform.

### Migration and Monitoring Plan

- **Migration:** none. The change is a behaviour change at
  call sites only. The SQLite schema is untouched.
- **Rollout:** forward-only. Existing pipeline runs and
  scoring snapshots remain in the database; new pipeline
  runs use the canonical SLD. `dominus portfolio rescore`
  updates portfolio entries in place.
- **Monitoring:** A simple smoke test — `dominus run
  --brandable nike.co.uk,foo.com.au,bar.com` — produces
  three candidates with `tld` values of `.co.uk`, `.com.au`,
  and `.com` respectively. The new
  `candidate-generation-stage.test.ts` pins this.
- **Rollback:** Revert the five commits. The interface
  reverts; the bug returns. The compiled output is not
  dependent on data the rollback would invalidate.

### Validation

- 39 unit tests in `utils/__tests__/domain.test.ts` cover
  the parser: gTLDs, multi-part ccTLDs, mixed case, empty
  input, single-character SLDs, numeric SLDs, fall-through
  for unknown multi-part suffixes.
- 32 trademark tests (18 detector + 14 gate) pass bit-
  identically after the import swap, proving the match
  detector's behaviour is unchanged.
- 50 scoring tests (intrinsic, commercial, expiry, market,
  engine, weights loader, backtest, suggester) pass. The
  intrinsic-signal tests gained 3 new cases pinning the
  multi-part TLD behaviour.
- 4 new candidate-generation-stage tests pin the
  brandable/closeout/closeout-entry flow with ccTLDs and
  the `.com` regression.
- 344 tests in total pass after the change; coverage on the
  touched modules is unchanged (≥70% per
  architecture-guardian §4).
- Production validation: a `dominus run` over a batch
  containing ccTLD names should produce a `tld` field of
  `.co.uk` / `.com.au` / `.ne.jp` (not `.uk` / `.au` /
  `.jp`); `dominus score nike.co.uk` should print
  `length: 4` in the intrinsic breakdown, not `7`.

### Follow-up Backlog

- A full Public Suffix List parser is the natural next step.
  The curated set's small footprint means the eventual swap
  is a one-line change inside `utils/domain.ts`.
- A separate ADR will address the EUIPO provider's
  end-of-life URL (the `copla/trademark/data-capture/V1/...`
  endpoint no longer exists; the new API is the
  "Trademark search 1.1.0" REST service on
  `dev.euipo.europa.eu` with RSQL queries and
  `X-IBM-Client-Id` header). EUIPO is currently returning 0
  hits silently on every query.
- The `STRICT_USPTO_TLDS` set in `trademark-gate.ts` is
  hard-coded; it is exported precisely so a follow-up can
  make it configurable without touching the gate's logic.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS
ADRs should be consistent with the product vision in
`dominus-product-vision.md`. Template:
`.claude/skills/adr/template.md`.*
