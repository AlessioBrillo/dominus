# Governance

DOMINUS is an open-source project with a single maintainer. This document
describes how decisions are made and how the community can participate.

## Maintainer

- **AlessioBrillo** — project founder and BDFL (Benevolent Dictator for Life)

The maintainer is responsible for:
- Reviewing and merging pull requests
- Setting the project roadmap and priorities
- Publishing releases to npm and GitHub Container Registry
- Managing security vulnerabilities
- Operating DOMINUS Cloud (the managed SaaS offering)

## License

DOMINUS Community is licensed under **AGPL v3**. This is a true open-source
license (OSI-approved). Anyone may use, study, share, and modify the software.
Anyone who modifies the software and offers it as a network service must
publish their modifications under the same license.

**Commercial licenses** are available for organizations that cannot or will not
comply with AGPL terms. Contact the maintainer for pricing.

Contributors are required to sign a Contributor License Agreement (CLA)
granting the project the right to relicense their contributions under both
AGPL v3 and commercial terms.

## Decision Making

Major architectural decisions are documented as Architecture Decision Records
(ADRs) in `docs/adr/`. Any significant change to the scoring engine, pipeline,
provider interface, database schema, licensing, or monetisation model requires
an ADR.

## Contributions

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Forking

DOMINUS Community is AGPL-licensed. You are free to fork the repository and
modify it for your own use. The maintainer encourages forks that experiment
with:

- Alternative scoring algorithms
- New data sources and providers
- Custom trademark matching policies
- Frontend dashboards and visualisations

If your fork produces a generally useful change, consider opening a pull request
to share it with the community. By contributing, you agree to the CLA terms.

## DOMINUS Cloud

DOMINUS Cloud is the managed SaaS offering of the same software. It runs the
identical codebase with added infrastructure for multi-tenancy, managed
PostgreSQL, automated backups, and priority support. The cloud service is
operated by the project maintainer.

The community edition (self-hosted) has every feature that DOMINUS Cloud has.
There is no feature gating — the cloud edition monetises managed infrastructure,
not software features.

## Versioning

DOMINUS follows [Semantic Versioning](https://semver.org/). The public API
includes:
- CLI commands and their options
- REST API endpoints and response shapes
- Provider interfaces (`TrademarkProvider`, `DnsProvider`, etc.)
- Database schema (via migrations)

## Release Process

1. Changes accumulate on `master`
2. When ready, a `vX.Y.Z` tag is pushed
3. CI builds, tests, and publishes to npm + GitHub Container Registry
4. A GitHub Release is created from the tag with auto-generated changelog
