# Contributing to DOMINUS

DOMINUS is an open-source project, and contributions are welcome.
This document outlines the development workflow and standards.

## License and CLA

DOMINUS Community is licensed under **AGPL v3**. Commercial licenses are
available separately.

**All contributors must sign a Contributor License Agreement (CLA)** before
their pull request can be merged. The CLA grants the project the right to
relicense contributions under both AGPL v3 and commercial terms. This is
standard practice for open-source projects with dual-licensing models
(see [ADR-0025](docs/adr/0025-license-change-agpl-commercial.md)).

The CLA is available in [`CLA.md`](CLA.md) (or will be provided as part of
the PR process).

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
   docs(adr): add ADR-0025 on license change
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

- [ADR-0001](docs/adr/0001-project-architecture.md) — Original technology decisions (superseded for SaaS era)
- [ADR-0002](docs/adr/0002-scoring-engine-design.md) — Scoring engine conservatism
- [ADR-0003](docs/adr/0003-pipeline-stage-separation.md) — Pipeline design
- [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md) — Provider interfaces
- [ADR-0006](docs/adr/0006-trademark-gate-mandate.md) — Trademark check mandate
- [ADR-0025](docs/adr/0025-license-change-agpl-commercial.md) — License and CLA
- [ADR-0026](docs/adr/0026-monetization-and-saas-model.md) — Monetisation and SaaS model
- [ADR-0027](docs/adr/0027-saas-architecture-multi-tenant.md) — Multi-tenancy and database
- [ADR-0028](docs/adr/0028-frontend-architecture-professional-dashboard.md) — Frontend architecture

## Code Standards

- **Language**: TypeScript (strict mode, ESM)
- **Formatting**: Prettier (single quotes, trailing commas, 100 print width)
- **Testing**: Vitest, 70% line coverage minimum (backed), 50% (frontend)
- **Imports**: Use `.js` extension for ESM compatibility
- **Errors**: Use the `DominusError` hierarchy with `code`, `message`, `context`
- **Documentation**: All identifiers, comments, and docs in English
- **API changes**: Must include Zod validation schema + OpenAPI documentation
- **Database changes**: Must include both SQLite and PostgreSQL-compatible DDL

## Community vs. Cloud

DOMINUS has a single codebase for both the community edition (AGPL, self-hosted)
and DOMINUS Cloud (managed SaaS). When contributing:

- **Community edition** uses SQLite, static API key auth, single-user defaults
- **DOMINUS Cloud** uses PostgreSQL, JWT auth, multi-tenant with RLS
- All new features must work with both backends unless explicitly documented
- The community edition must never be artificially limited or feature-gated

## Adding a Provider

1. Define the interface in `src/providers/<name>/<name>-provider.ts`
2. Implement the interface in `src/providers/<name>/<impl>.ts`
3. Test with a mock in `src/providers/<name>/__tests__/`
4. Wire it in `src/app/composition-root.ts`
5. Add a row to `reportProviderStatuses()` in `src/app/provider-status.ts`
6. Document the new `.env` variable in `.env.example`

## Adding a Database Migration

1. Create `src/db/migrations/NNNN-description.ts` with a DDL constant
2. Add it to the migration list in `src/db/migrator.ts`
3. Ensure the DDL is compatible with both SQLite and PostgreSQL
4. Add a repository class in `src/db/repositories/` if needed
5. Test with both an in-memory SQLite database and a PostgreSQL test container

## Pull Request Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (no new warnings)
- [ ] `npm test` passes (existing + new tests)
- [ ] Architecture principles satisfied (no provider calls in business logic,
      trademark gate is not bypassed, scoring is heuristic-only)
- [ ] No secrets, credentials, or `.env` files are committed
- [ ] Documentation updated if behaviour changed
- [ ] New features work with both SQLite and PostgreSQL backends
- [ ] Branch is rebased on latest master
- [ ] CLA is signed (first-time contributors)
