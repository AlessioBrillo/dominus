---
name: preflight
description: >
  Local pre-push quality gate for DOMINUS. Runs typecheck, lint, and test
  commands for TypeScript/Node.js code, audits the diff for code quality
  and security issues, and validates DOMINUS architecture principles.
  Invoke before git push to prevent CI failures on remote.
disable-model-invocation: true
allowed-tools: Bash(npm *) Bash(git *) Read Grep Glob
---

# Preflight — Local Quality Gate

This skill runs a complete local check before you push to remote. It runs typecheck, lint, and test commands for affected modules, and audits the diff for code quality, security, and architecture violations. If any check fails, stop and fix before pushing.

---

## Current Changes

### Staged and Uncommitted Changes

!`git status --short`

!`git diff HEAD`

### Changed Files & Stats (Local Working Tree)

!`git diff --name-only HEAD`

!`git diff --stat HEAD`

### Committed but Unpushed Changes (Current Branch)

!`git log @{u}..HEAD --oneline`

!`git diff @{u}...HEAD --stat`

---

## Mode Selection

Three modes. When `$ARGUMENTS` is empty, run all steps (full mode).

| Mode | Command | Behaviour |
|------|---------|-----------|
| Full | `/preflight` | Typecheck + lint + test + diff audit |
| Quick | `/preflight quick` | Typecheck + lint + diff audit (skip tests) |
| Diff only | `/preflight diff` | Diff audit only (no typecheck/lint/test) |

---

## Step 1 — Classify Changes

From the list of changed files, determine which module areas are affected:

| Area | Path prefix | Commands |
|------|-------------|----------|
| Core backend | `src/` | `npm run typecheck`, `npm run lint`, `npm run test` |
| Frontend | `frontend/` | `npm run typecheck` (in `frontend/`), `npm run lint` (in `frontend/`) |
| Database | `src/db/` | `npm run typecheck` (schema migrations are TypeScript) |

*If only documentation files changed (`*.md`, `docs/`), skip Step 2 entirely and proceed directly to the diff audit.*

---

## Step 2 — Run Module Checks

For each affected area, execute the commands listed above **in order**. If any command fails (non-zero exit code), stop for that area. Record successes and failures for the report.

### 1. Core Backend (`src/`)
Use `workdir: .` (project root).
1. `npm run typecheck`
2. `npm run lint`
3. If mode is NOT `quick`: `npm run test`

### 2. Frontend (`frontend/`)
Use `workdir: frontend`.
1. `npm run typecheck`
2. `npm run lint`
3. If mode is NOT `quick`: `npm run test`

### Toolchain Missing
If `npm` is not available, report the check as `⏭ skipped (Toolchain Missing / Degraded)` and proceed to the diff audit.

---

## Step 3 — Diff Audit

Audit the diff of all changes. If the diff is very large (> 200 lines or > 15KB), do **not** dump or read the whole raw diff. Instead, use `Read` or `Grep` target-wise on modified areas.

Verify each item below:

### Security
- [ ] No hardcoded secrets, API keys, tokens, passwords, or connection strings in the diff
- [ ] No `.env` files, credentials files, or private keys are staged
- [ ] All SQL queries use parameterized statements (check for `db.prepare()` with string concatenation)
- [ ] Domain name inputs are validated before any provider call

### Code Quality
- [ ] No debug code left in: `console.log`, `debugger` (except in CLI output formatters)
- [ ] No unresolved `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` markers in changed lines
- [ ] No commented-out code blocks
- [ ] No excessively large functions (> 60 lines) or files (> 500 lines) introduced
- [ ] Error handling is present: try/catch or `.catch()` on async operations

### Architecture (from architecture-guardian)
- [ ] No direct provider API calls in business logic (check for `dns.`, `fetch()`, `axios` calls outside `providers/` directory)
- [ ] Trademark gate is not bypassed (no buy recommendation logic before trademark check)
- [ ] Scoring engine does not use ML libraries (heuristic only — §6 of vision)
- [ ] Provider implementations are behind interfaces (check for `implements XxxProvider` pattern)
- [ ] New files are placed in the correct module directory (`src/providers/`, `src/scoring/`, etc.)
- [ ] All identifiers, comments, and documentation are in English

### Tests
- [ ] New public functions, classes, or components have corresponding test files
- [ ] Changed public APIs include test updates
- [ ] Test files follow project convention: `*.test.ts` suffix

---

## Step 4 — Generate Report

Produce a structured report in this exact format:

```
╔══════════════════════════════════════════════════════╗
║              PREFLIGHT REPORT                        ║
╚══════════════════════════════════════════════════════╝

Areas Checked: <List of affected areas, e.g., Core Backend, Frontend>

Checks:
  Typecheck ✅ / ❌ / ⏭ skipped / ⚠️ degraded
  Lint      ✅ / ❌ / ⏭ skipped / ⚠️ degraded
  Test      ✅ / ❌ / ⏭ skipped (quick mode or Toolchain Missing)

Audit:
  Security ✅ / ❌ / ⚠️ warning
  Quality  ✅ / ❌ / ⚠️ warning
  Arch     ✅ / ❌ / ⚠️ warning
  Tests    ✅ / ❌ / ⚠️ warning

Verdict: PASS ✅ | PASS WITH WARNINGS ⚠️ | FAIL ❌

Issues:
─────────────────────────────────────────────
  ❌ src/providers/whois.ts:42 — Direct dns.resolve() call in non-provider code
  ⚠️ src/scoring/engine.ts:15 — TODO comment in changed lines
  ...
```

### Verdict Criteria

| Verdict | Condition |
|---------|-----------|
| PASS ✅ | All checks passed, no errors in audit, zero warnings or only trivial warnings |
| PASS WITH WARNINGS ⚠️ | All checks passed (or degraded/skipped), audit has warnings but no errors |
| FAIL ❌ | Any check failed, or audit has any error |
