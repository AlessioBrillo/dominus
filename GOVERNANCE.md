# Governance

DOMINUS is an open-source project with a single maintainer. This document
describes how decisions are made and how the community can participate.

## Maintainer

- **AlessioBrillo** — project founder and BDFL (Benevolent Dictator for Life)

The maintainer is responsible for:
- Reviewing and merging pull requests
- Setting the project roadmap and priorities
- Publishing releases to npm and GitHub Packages
- Managing security vulnerabilities

## Decision Making

Major architectural decisions are documented as Architecture Decision Records
(ADRs) in `docs/adr/`. Any significant change to the scoring engine, pipeline,
provider interface, or database schema requires an ADR.

## Contributions

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Forking

DOMINUS is MIT-licensed. You are free to fork the repository and modify it for
your own use. The maintainer encourages forks that experiment with:

- Alternative scoring algorithms
- New data sources and providers
- Custom trademark matching policies
- Frontend dashboards and visualisations

If your fork produces a generally useful change, consider opening a pull request
to share it with the community.

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
4. A GitHub Release is created from the tag
