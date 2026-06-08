# ADR-0012: Trademark matching policy and `.com` USPTO fallback

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-07 |
| **Authors** | DOMINUS team |
| **Deciders** | DOMINUS team |
| **Supersedes** | N/A |
| **Relates to** | ADR-0006 (pipeline sequential), ADR-0010 (rescore bridge), architecture-guardian §1 Principle 6 (trademark gate is non-negotiable) |
| **Project** | DOMINUS |

## Context

The trademark gate is the last stage of the pipeline and the only
gate that can produce a hard "Block" verdict on a candidate. Its
two responsibilities are:

1. **Match detection** — given a candidate SLD and a list of
   registered marks from USPTO/EUIPO, decide whether the SLD
   conflicts with any mark. A conflict is a Block.
2. **Source coverage** — decide whether the verdict is "Clear",
   "Blocked", or "Unverified", based on which providers responded
   and what the search results contain.

The previous implementation got both responsibilities subtly wrong:

**Match detection** was a single bidirectional substring check
(`sld.includes(mark) || mark.includes(sld)`). That rule is
simultaneously over- and under-conservative:
- **Over**: `app.com` blocks on the mark "Apple" because
  "app" is a substring of "apple" after lowercase. `bo.com`
  blocks on "Boss". `estate.com` blocks on "State Farm" because
  "state" is a substring of "estate". A buy list made with this
  rule rejects every plausible 2-3 letter brand.
- **Under**: real collision candidates that do not contain the
  mark verbatim (typo-squatters like `applle.com` against "Apple")
  are missed because the strict `includes` check fails on
  character substitution.

The two failure modes cancel out statistically but mask each
other in production: the operator sees a smaller buy list and
assumes the gate is working. The bias is invisible until an audit.

**Source coverage** had a quieter but more dangerous failure.
USPTO's `tmsearch.uspto.gov` endpoint is behind AWS WAF and
routinely returns non-200 to server-side requests (the provider
itself documents this in its header comment). In practice the
gate regularly degraded to "EUIPO-only Clear" with
`partial=true` for `.com` domains. A US-jurisdiction asset was
being cleared on a register that does not cover US marks. The
operator got a "Clear" verdict with a "partial" banner that was
easy to miss — silent risk on the buy list.

`extractSld` also had a latent bug: for a multi-part TLD like
`.co.uk`, it concatenated the SLD and the second-level suffix,
returning `nikeco` instead of `nike`. The substring check
happened to "work" for short SLDs because the wrong token
included the right one, but token-aware matching cannot be
delivered until `extractSld` is fixed.

## Decision Drivers

1. **Principle 6 is non-negotiable** — every buy recommendation
   must rest on a non-bypassable trademark check.
2. **The scoring engine must be conservative** (Principle 5),
   and the trademark gate is the *most* conservative stage.
3. **No paid API in MVP** — the gate is built on free public
   endpoints, which means resilience to provider outages is a
   first-class design constraint, not a future hardening.
4. **Match detection must be defensible** — the rule that
   produces a Block must be explainable in a sentence. "The SLD
   is the same word as the mark" is defensible; "the SLD
   contains the mark as a substring" produces too many false
   positives to be defensible in front of an operator reviewing
   the rejected list.
5. **Operationally observable** — when a provider is down, the
   operator should know *which* provider, not just see a vague
   "partial" flag.

## Considered Options

### Option A: Token-exact match + Levenshtein-1 fallback (CHOSEN)

Replace the substring rule with a token-aware algorithm:

1. Tokenise the SLD on non-letters (lowercase, digit-to-word).
2. Tokenise each mark the same way; a compound mark like
   "App Store" becomes the token list `[app, store]`.
3. A mark matches when **every** one of its tokens is covered by
   some SLD token. Coverage means one of:
   - (a) exact equality post-normalisation
   - (b) the SLD token contains the mark token as a substring,
     allowed only when the mark token is at least 3 letters
   - (c) Levenshtein distance at most 1, allowed only when both
     tokens are at least 4 letters and their length gap is at
     most 1
4. A compound mark matches only when every one of its tokens is
   covered, so `app.com` does NOT match the mark "App Store".

**Advantages:**
- The same word matches (exact), typosquatters match
  (Levenshtein-1), compound marks match when all tokens are
  present (substring containment), and over-matches are
  rejected (token boundary + minimum length gates).
- Easy to explain: "the SLD contains the mark, or differs by
  one character on a long token, or includes every token of
  the compound mark".
- Levenshtein is 30 lines of iterative DP, no new runtime
  dependency.

**Disadvantages:**
- Adds a small CPU cost per candidate (linear in the number of
  marks × tokens). At our volumes (≤ 50 hits per provider per
  query) this is invisible.
- The Levenshtein-1 threshold of "4 letters" is a magic
  number; it is justified in the unit tests but it is a value
  the operator may want to tune later via a config knob.

**Cost Implications:** Trivial. ~120 LOC + tests, no new
dependency. The only "cost" is reading 18 more test cases.

**Risk Assessment:** Low. The behaviour change is well-scoped
(matches `detectMatch`'s contract). Tests cover the regressions
and the new positives side by side.

---

### Option B: Token-exact match (no edit distance)

Drop the Levenshtein-1 fallback. Marks and SLDs only match on
exact token equality or substring containment.

**Advantages:**
- Simpler to reason about, no edit-distance magic.
- Slightly faster per query.

**Disadvantages:**
- Misses typo-squatters: `applle.com` against "Apple" passes
  the gate. This is the single biggest class of "looks legit
  but is litigated" acquisitions.
- The operator has no way to opt back into edit-distance
  matching later without a code change.

**Cost Implications:** Even less code than A.

**Risk Assessment:** Medium. Letting typo-squatters through is
a real downside; Principle 5 (conservatism) is better served
by A.

---

### Option C: Substring match + Nice-class filter

Keep the substring match but add a Nice-class check: only Block
when the mark's Nice class is related to the candidate's
apparent commercial intent.

**Advantages:**
- Fewest false positives on a well-curated TM register.
- Theoretically the most legally correct.

**Disadvantages:**
- Requires a Nice-class lookup for every USPTO/EUIPO match,
  which neither free endpoint returns in a normalised form. The
  match already carries `markName`, `owner`, `status` and
  `source`; a Nice class would mean a second provider query per
  hit. Cost goes up; free-tier rate limits go down.
- "Commercial intent" from an SLD alone is not a well-defined
  problem. `app.com` could be a developer tool, a finance app,
  a food brand, a clothing line, a "let us application" service.
  Picking a default class is heuristic and brittle.

**Cost Implications:** Significantly higher. A second TM
endpoint or a class-mapping table; an additional provider
abstraction.

**Risk Assessment:** High. We over-engineer for a 1-user system
and introduce a source of new false negatives (wrong class
assignment).

---

### Option D: Status quo (substring match, no strict TLD)

No behaviour change. Document the known limitations in a
follow-up.

**Advantages:**
- Zero work; zero risk of regression.

**Disadvantages:**
- The operator continues to lose 5-10 legitimate candidates per
  pipeline run to false Block verdicts and to silently accept
  `.com` names that have a USPTO conflict EUIPO did not surface.
- The detection bug has been live since MVP. Every pipeline run
  since then has been biased.

**Cost Implications:** Zero work, but the cost of the bias is
real and silent.

**Risk Assessment:** High. The bias is the *opposite* of
Principle 5 (conservatism on the wrong axis — over-conservative
on the buy list, under-conservative on US coverage).

## Decision

**Chosen option: Option A — token-exact + Levenshtein-1 + strict
TLD rule.**

The detector (Option A) is the conservative match algorithm the
project has been missing since MVP. The strict TLD rule for
`.com` and `.us` (new in this ADR) sits on top of the gate
itself, not on the detector: when USPTO is unreachable AND the
domain is a US-jurisdiction TLD, the gate returns `Unverified`
rather than risk a false Clear. EUIPO-only is still acceptable
for non-strict TLDs (`.io`, `.ai`, `.co`) where the ccTLD does
not signal US jurisdiction.

For each decision driver:

- **Driver 1 (Principle 6)** — the new algorithm removes
  spurious Blocks and adds real ones; the strict TLD rule makes
  coverage honest on `.com`.
- **Driver 2 (Principle 5)** — the conservatism axis is now
  aligned: the gate is *more* conservative than substring
  matching on TM risk, never less.
- **Driver 3 (no paid API)** — Levenshtein is implemented in
  30 LOC; no new dependency. The strict TLD rule is a behaviour
  change, not a new vendor.
- **Driver 4 (defensibility)** — the rule is one sentence per
  match: "every mark token is either the same word as an SLD
  token, is contained in a longer SLD token, or differs from an
  SLD token by at most one character on a 4-letter-or-longer
  token."
- **Driver 5 (observability)** — the new `usptoFailed` flag on
  `GateResult` lets the operator (and future dashboards)
  distinguish USPTO outages from EUIPO outages.

## Consequences

### Positive
- **Buy list quality**: a `.io` typo-squatter that does not
  contain a mark verbatim (e.g. `applle.io` against "Apple")
  is now correctly Blocked instead of Clear.
- **Coverage honesty**: a `.com` candidate is no longer cleared
  on EUIPO alone when USPTO is unreachable. The `Unverified`
  verdict forces the operator to either retry USPTO or pass on
  the name.
- **Reduced false positives**: legitimate 2-3 letter brands
  like `bo.com`, `app.com`, `estate.com` are no longer blocked
  by token-overlap noise.
- **Multi-part TLD handling**: `nike.co.uk` returns `nike`
  (not `nikeco`), so the mark lookup is correct for the
  common ccTLDs.

### Negative
- **Curated multi-part TLD list**: the `MULTI_PART_TLDS` set
  is a snapshot of the most common ccTLDs; new gTLD delegations
  (e.g. `bar.baz.qux`) fall through to the first-label default.
  This is the right trade-off at single-user scale; a future
  change can swap the constant for a full Public Suffix List
  parser without touching the matching logic.
- **`CandidateGenerationStage.extractTld` has the same latent
  bug**: it returns `.uk` for `nike.co.uk`, and downstream
  scoring signals use `domain.replace(tld, '')` which leaves
  `nike.co`. The fix is out of scope for this ADR but should
  land in a follow-up — otherwise the scoring engine treats
  `co` as a meaningful SLD token and the TM gate is the only
  component that handles ccTLDs correctly.
- **Strict TLD set is hard-coded**: `STRICT_USPTO_TLDS` is
  currently `{.com, .us}`. A future change may need
  jurisdiction-specific rules (e.g. `.de` requiring a Deutsches
  Patent- und Markenamt lookup, not just EUIPO). The set is
  exported precisely so a follow-up can make it configurable
  without touching the gate.

### Compliance and Security Implications
- No new PII, no credentials, no API keys.
- The strict TLD rule is a *defensive* compliance change: a
  US-jurisdiction name is no longer cleared without a US-jurisdiction
  source.
- The new detector is more conservative on the "typosquatter"
  axis, which is the dominant legal-risk vector for
  aftermarket domain acquisition.

### Migration and Monitoring Plan
- **Migration**: no data migration. The pipeline_runs table
  is event-sourced; the change applies on the next `dominus run`.
- **Rollout**: feature-flagged by the algorithm change itself.
  The detector is binary-correct (matches a strictly larger
  set than before, never a strictly smaller set on the
  regression cases we care about).
- **Monitoring**:
  - A simple `dominus run | grep -c "verdict=blocked"` count
    over a week gives a baseline of how many more Blocks the
    new rule produces (expect a small uptick from typo-squatter
    blocks).
  - The new `usptoFailed` flag is recorded in the gate's
    output; a simple SQL query on the
    `pipeline_runs.results_summary` JSON (or a future column)
    surfaces the USPTO outage rate.
- **Rollback**: revert the detector commit; the strict TLD
  commit is independent and can be reverted on its own.

### Validation
- 18 new detector test cases plus the 4 prior cases — all
  pass. The regression cases (app vs Apple, bo vs Boss,
  estate vs State Farm) are pinned.
- 7 new gate test cases for the strict TLD rule plus the 7
  adapted pre-existing cases — all pass.
- Production validation: a `dominus run` over a known
  candidates list should produce:
  - A non-zero increase in `verdict=blocked` for `.com` names
    that contain trademark tokens but not the full mark.
  - A non-zero increase in `verdict=unverified` for `.com`
    names during USPTO outage windows.
  - A decrease in false-positive Blocks on legitimate 2-3
    letter brands.

### Follow-up backlog
- `CandidateGenerationStage.extractTld` and the scoring
  signals' `sld = input.domain.replace(input.tld, '')` use
  the same naive TLD detection. A new ADR will address
  domain parsing in a single place.
- The `STRICT_USPTO_TLDS` set may grow as the operator
  acquires names on additional TLDs.
- A full Public Suffix List parser is a follow-up.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS
ADRs should be consistent with the product vision in
the ADR series starting at `docs/adr/0001-project-architecture.md`. Template:
`.claude/skills/adr/template.md`.*
