---
name: github-workflow
description: >
  Git branching, commit, and push workflow for DOMINUS — personal domain
  investment tool. Trunk-based development, short-lived branches,
  Conventional Commits, single-dev flow. Always load this skill with
  /github-workflow before making changes.
disable-model-invocation: true
allowed-tools: Bash(git *) Bash(gh *)
---

# GitHub Workflow — DOMINUS

Single source of truth for every Git operation in this project. Covers branching, committing, preflight, pushing, and pull requests.

---

## 1. Branching Convention

### Strategy: Trunk-based Development

- The only permanent branch is `main` (the trunk).
- All work happens on **short-lived branches** — hours to a few days.
- **Never commit directly to `main`.** Every change goes through a branch.

### Branch Naming

```
<type>/<description>
```

| Type | When to use |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `refactor` | Code restructuring without behaviour change |
| `docs` | Documentation-only changes (README, ADR, docs) |
| `style` | Formatting, whitespace; NOT functional |
| `perf` | Performance improvement |
| `test` | Adding or correcting tests only |
| `build` | Build system, dependencies, tooling (package.json, tsconfig) |
| `ci` | CI/CD configuration |
| `chore` | Maintenance, config, tasks not fitting above |

Rules:
- Description is **lowercase kebab-case** (hyphens as separators).
- Total branch name length: **72 characters maximum**.
- Examples: `feat/domain-scoring-engine`, `fix/rdap-timeout-retry`, `refactor/provider-interfaces`.

---

## 2. Full Lifecycle — Branch to Merge

```
 1. BRANCH    — git checkout -b <type>/<description>
 2. CODE      — Make changes following architecture-guardian conventions
 3. COMMIT    — git add + conventional commit message (see §2)
 4. PREFLIGHT — /preflight (run local quality gate before pushing)
 5. PUSH      — git push -u origin <branch>
 6. PR        — gh pr create (see §4)
 7. MERGE     — Squash-merge into main
 8. CLEANUP   — Delete the feature branch (git branch -D)
```

---

## 2. Commit Standard (Conventional Commits 1.0.0)

### Current Diff

!`git diff HEAD`

### Changed Files

!`git diff --name-only HEAD`

### Diff Statistics

!`git diff --stat HEAD`

### Commit Message Structure

```
<type>(<scope>): <description>

<body>

<footer>
```

### Type Classification

Use the type table from §1. Pick the one that best describes the **primary purpose** of the change.

### Scope Derivation

Derive scope from the module directory:

| Path prefix | Scope |
|-------------|-------|
| `src/pipeline/` | `pipeline` |
| `src/scoring/` | `scoring` |
| `src/providers/` | `provider` (append provider name: `provider/whois`, `provider/rdap`) |
| `src/trademark/` | `trademark` |
| `src/portfolio/` | `portfolio` |
| `src/db/` | `db` |
| `src/cli/` | `cli` |
| `frontend/` | `frontend` |
| `docs/` | `docs` |
| `.github/` | `ci` |
| root config files | `build` |

### Description Rules

- **Imperative present tense**: "add" not "added" or "adds"
- **Max length**: 50 characters (hard limit)
- **No trailing period**
- **No leading capitalisation**

### Body Rules

- Blank line after description
- Wrap at **72 characters per line**
- Explain **WHY**, not **WHAT** — the diff already shows what changed
- Reference ADRs, issues, or design decisions

### Footer Rules

- Blank line after body
- `BREAKING CHANGE: <description>` if backward compatibility is broken
- `Refs: ADR-NNNN` for architecture decision records

### Commit Checklist

- [ ] Type is one of the valid types from §1
- [ ] Scope is meaningful and derived from actual changed files
- [ ] Description is imperative present tense, ≤50 characters, no trailing period
- [ ] Body explains WHY the change was made, wrapped at 72 characters
- [ ] No secrets, credentials, or `.env` files are staged

---

## 3. Preflight — Local Quality Gate

After committing and before pushing, run:

```bash
/preflight
```

The preflight skill automatically runs `npm run typecheck`, `npm run lint`, `npm run test`, and audits the diff. Do not push if preflight fails.

| Mode | Command | Behaviour |
|------|---------|-----------|
| Full | `/preflight` | Typecheck + lint + test + diff audit |
| Quick | `/preflight quick` | Typecheck + lint + audit (skip tests) |
| Diff only | `/preflight diff` | Diff audit only |

---

## 4. Pull Requests

### Creating a PR

After the branch is pushed and preflight passes:

```bash
gh pr create --title "<conventional-commit-title>" --body "<body>"
```

### PR Body Template

```
## Summary

- <what changed and why — 2-3 bullet points>

## Related

- Refs: ADR-NNNN (if applicable)

## Checklist

- [ ] Preflight passed (typecheck, lint, test, diff audit)
- [ ] Architecture principles satisfied (see architecture-guardian)
- [ ] Security checklist verified (no secrets, no injection vectors)
- [ ] Tests added or updated
- [ ] Branch is rebased on latest main
```

### PR Requirements (Single-Dev)

- **Preflight must pass** before creating the PR
- **Review is optional** (solo project) — merge at your discretion
- **No merge conflicts** with `main` — rebase if needed
- **Squash-merge** is the preferred strategy (clean linear history on `main`)

---

## 5. Non-negotiable Safety Rules

- **Never** commit directly to `main`
- **Never** force-push (`git push --force` or `git push --force-with-lease`) to `main`
- **Never** force-push to a branch that may have been pushed
- **Never** amend or rebase a commit that has already been pushed — add a new commit instead
- **Never** commit credentials, API keys, `.env` files, `node_modules/`, build artifacts, or large binaries
- **All written output must be in English**: code comments, doc comments, commit messages, variable names, file names, documentation files, ADRs, READMEs
- **One concern per branch.** A branch should address exactly one logical change
- **Always run `/preflight` before pushing.** Catching issues locally saves time

---

## 6. Argument Reference

| Invocation | Behaviour |
|------------|-----------|
| `/github-workflow` | Load the full workflow reference |
| `/github-workflow commit-message` | Generate a commit message for the current diff |
| `/github-workflow create-pr` | Guide through creating a pull request |

When `$ARGUMENTS` is `commit-message`, output ONLY the commit message in a fenced code block — no commentary, no preamble, no explanation.

When `$ARGUMENTS` is `create-pr`, output ONLY the `gh pr create` command with a pre-filled body template.
