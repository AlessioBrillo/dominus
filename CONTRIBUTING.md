# Contributing to DOMINUS

DOMINUS is a single-developer project, but contributions are welcome.
This document outlines the development workflow and standards.

## Development Setup

```bash
git clone https://github.com/AlessioBrillo/dominus.git
cd dominus
npm install
cp .env.example .env
npm run build
npm test
```

## Development Workflow

DOMINUS follows **trunk-based development** on the `master` branch.

1. Create a short-lived branch from `master`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. Make changes with **atomic commits** following [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat(scoring): add auction-price signal
   fix(rdap): handle timeout on premium detection
   docs(adr): add ADR-0016 on registrar abstraction
   ```

3. Run the quality gate before pushing (backend + frontend):
   ```bash
   npm run ci:backend    # typecheck, build, lint, format, test with coverage
   npm run ci:frontend   # typecheck, lint, test, build
   ```

4. Push, create a PR, wait for CI to pass, then squash-merge.

## Architecture

See the [ADR series](docs/adr/README.md) for the full architecture documentation.
Key documents:

- [ADR-0001](docs/adr/0001-project-architecture.md) — Technology decisions
- [ADR-0002](docs/adr/0002-scoring-engine-design.md) — Scoring engine conservatism
- [ADR-0003](docs/adr/0003-pipeline-stage-separation.md) — Pipeline design
- [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md) — Provider interfaces
- [ADR-0006](docs/adr/0006-trademark-gate-mandate.md) — Trademark check mandate

## Code Standards

- **Language**: TypeScript (strict mode, ESM)
- **Formatting**: Prettier (single quotes, trailing commas, 100 print width)
- **Testing**: Vitest, 80% line coverage minimum
- **Imports**: Use `.js` extension for ESM compatibility
- **Errors**: Use the `DominusError` hierarchy with `code`, `message`, `context`
- **Documentation**: All identifiers, comments, and docs in English

## Adding a Provider

1. Define the interface in `src/providers/<name>/<name>-provider.ts`
2. Implement the interface in `src/providers/<name>/<impl>.ts`
3. Test with a mock in `src/providers/<name>/__tests__/`
4. Wire it in `src/index.ts` and `src/cli/index.ts` if needed
5. Add a row to `reportProviderStatuses()` in `src/app/provider-status.ts`
6. Document the new `.env` variable in `.env.example`

## Adding a Database Migration

1. Create `src/db/migrations/NNNN-description.ts` with a DDL constant
2. Add it to the migration list in `src/db/migrator.ts`
3. Add a repository class in `src/db/repositories/` if needed
4. Test with an in-memory database

## Pull Request Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (no new warnings)
- [ ] `npm test` passes (existing + new tests)
- [ ] Architecture principles satisfied (no provider calls in business logic,
      trademark gate is not bypassed, scoring is heuristic-only)
- [ ] No secrets, credentials, or `.env` files are committed
- [ ] Documentation updated if behaviour changed
- [ ] Branch is rebased on latest master
