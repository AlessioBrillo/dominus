---
name: adr
description: >
  Create an Architecture Decision Record (ADR) following the MADR (Markdown Architectural
  Decision Records) 4.0.0 standard. Produces a formally structured document with
  status header, comprehensive context analysis, quantified decision drivers, exhaustive
  alternatives enumeration with pros/cons evaluation, chosen option with rationale, and
  positive/negative consequences. Writes sequentially numbered ADR files to docs/adr/.
disable-model-invocation: true
allowed-tools: Bash(*) Read Write
---

# Architecture Decision Record — DOMINUS Standard

Create an ADR for the decision titled: `$ARGUMENTS`

---

## Preconditions

1. If `$ARGUMENTS` is empty, prompt the user: `ADR title is required. Usage: /adr <decision-title>`
2. Read `docs/adr/` directory to determine the next sequential number (NNNN format, zero-padded)
3. Generate the filename as `docs/adr/NNNN-$title-with-dashes.md`
4. If the file already exists, append a suffix: `NNNN-$title-2.md`
5. Read the template from `${CLAUDE_SKILL_DIR}/template.md` to get the exact ADR format

---

## Required Analysis

Before writing, gather and analyze the following:

1. **Context**: What business and technical factors prompted this decision? What is the current state of the system relevant to this decision?
2. **Decision Drivers**: List 2-5 concrete forces driving this decision (cost, accuracy, simplicity, time-to-market, vendor lock-in risk, API cost, data quality, conservatism)
3. **Alternatives**: Identify 2-4 realistic alternatives. For each, document:
   - Description of the approach
   - Advantages (minimum 2)
   - Disadvantages (minimum 2)
   - Cost implications (development effort, operational cost, licensing, API costs)
   - Risk assessment (technical risk, vendor risk, migration risk)
4. **Decision**: Select exactly one option with:
   - Rationale explaining WHY this option wins over each alternative
   - Qualitative and quantitative justification where possible
5. **Consequences**: For the chosen option, document:
   - Positive consequences (minimum 2)
   - Negative consequences (minimum 1)
   - Compliance and security implications
   - Migration and monitoring plan
   - How this decision will be validated

---

## Writing Requirements

1. Load the template from `${CLAUDE_SKILL_DIR}/template.md` for the exact structure
2. Replace all placeholder values in angle brackets with actual content
3. Set date as today's date in YYYY-MM-DD format
4. Set status to `Proposed`
5. Write the file using the Write tool
6. AFTER writing, read the file back to verify correctness

---

## ADR Index Maintenance

After creating the ADR:

1. Read `docs/adr/README.md` if it exists
2. If it exists, add an entry for the new ADR in the index table with number, title, date, and status
3. If it does not exist, create `docs/adr/README.md` with:
   ```markdown
   # Architecture Decision Records

   This directory contains all Architecture Decision Records (ADRs) for DOMINUS.

   | ADR | Title | Date | Status |
   |-----|-------|------|--------|
   | NNNN | Title | YYYY-MM-DD | Proposed |
   ```

---

## Quality Gates

Before finishing, verify:
- [ ] The ADR filename follows the `NNNN-title-with-dashes.md` convention
- [ ] The `Status` field is set correctly
- [ ] The `Date` field is in YYYY-MM-DD format
- [ ] At least 2 alternatives were considered and documented
- [ ] Each alternative has both pros and cons
- [ ] The decision rationale explains why each alternative was rejected
- [ ] Consequences include both positive and negative outcomes
- [ ] File is valid Markdown
- [ ] No placeholder angle brackets remain unfilled

---

## Output

Return the following summary:
- ADR file path
- Title
- Status and date
- Number of alternatives evaluated
- Brief summary of the decision and rationale
