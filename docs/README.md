# Documentation

DOMINUS is an open-source decision-support tool for domain investment,
shipped as a self-hosted community edition (AGPL v3) and as the managed
DOMINUS Cloud service. **The community edition and DOMINUS Cloud have
exactly the same feature set** — Cloud monetises hosting, not features
([ADR-0026](adr/0026-monetization-and-saas-model.md)).

Start here, in this order:

| # | Document | Read it if you want to... |
|---|----------|---------------------------|
| 1 | [Quick Start](#) in [README.md](../README.md) | score a domain in the next two minutes |
| 2 | [Self-hosting guide](guides/self-hosting.md) | run the community edition end to end |
| 3 | [Closeouts to a buy decision](guides/closeouts-to-buy-decision.md) | turn an imported closeout CSV into a buy/pass verdict |
| 4 | [Portfolio keep/drop](guides/portfolio-keep-drop.md) | decide what to renew and what to drop |
| 5 | [Scoring engine](adr/0002-scoring-engine-design.md) | understand how a value is derived and why it is deliberately conservative |
| 6 | [API reference](#api-reference) | integrate programmatically |

## Guides

Task-oriented, each one start to finish:

- [Self-hosting](guides/self-hosting.md) — SQLite or PostgreSQL, with the
  validating Unbound resolver that "available" verdicts depend on
- [Closeouts to a buy decision](guides/closeouts-to-buy-decision.md) —
  the five-stage pipeline on real closeout data
- [Portfolio keep/drop](guides/portfolio-keep-drop.md) — the renewal clock
  and the drop engine
- [Cloud team setup with SSO](guides/cloud-team-sso.md) — Auth0 OIDC,
  team seats, email invitations (ADR-0081)
- [Automation runbook](guides/automation-runbook.md) — the post-acquisition
  pipeline, its kill switch and dry-run (ADR-0083)

## Deployment

- [Deployment guide](deployment/README.md) — quick start through immutable
  deploys, gate → migrate → roll, backups
- [npm publishing runbook](releases/npm-publishing.md) — the one-time OIDC
  trusted-publisher setup, and how a consumer verifies provenance
- [Migration policy](releases/migration-policy.md) — how schema changes are
  released, including the operational runbook
- [Upgrade to 1.1.0](releases/upgrade-1.1.0.md) — what changed and what you
  must set (`DNS_UNBOUND_HOSTS`)
- [Terraform (Hetzner)](../deploy/terraform/README.md) — two-node Cloud
  infrastructure: app node, PITR database node, Caddy with TLS

## Operations

- [RTO / RPO](operations/rto-rpo.md) — recovery targets and the recovery
  runbook
- [Incident response](operations/incident-response.md) — severity ladder,
  escalation, post-mortem
- [Service level agreement](operations/sla.md) — what Enterprise commits to
- [Backup and operations](adr/0022-backup-and-operations.md) — automatic
  daily backup, manual commands, pruning

## Security

- [Reporting a vulnerability](../SECURITY.md) — GitHub private vulnerability
  reporting, 7-day response
- [First-party security review, August 2026](security/audit-2026-08.md) —
  scope, findings and dispositions
- [License and IP protection](adr/0036-license-and-ip-protection.md) —
  AGPL, the commercial option, the DOMINUS project mark

## Architecture

The [ADR series](adr/README.md) is the primary design record — 83 accepted
decisions, indexed. Start with these:

| ADR | Decision |
|-----|----------|
| [ADR-0001](adr/0001-project-architecture.md) | Original architecture (superseded in part by ADR-0026/0027) |
| [ADR-0002](adr/0002-scoring-engine-design.md) | The conservatism principle: never over-value |
| [ADR-0003](adr/0003-pipeline-stage-separation.md) | The five-stage pipeline |
| [ADR-0004](adr/0004-provider-abstraction-pattern.md) | Provider abstraction is non-negotiable |
| [ADR-0006](adr/0006-trademark-gate-mandate.md) | The trademark gate runs on every candidate |
| [ADR-0025](adr/0025-license-change-agpl-commercial.md) | AGPL v3 + commercial option |
| [ADR-0026](adr/0026-monetization-and-saas-model.md) | Hosting-only monetisation, no feature gating |
| [ADR-0027](adr/0027-saas-architecture-multi-tenant.md) | Multi-tenancy and RLS |
| [ADR-0038](adr/0038-tenant-isolation.md) / [0038](adr/0038-usage-enforcement.md) | Tenant isolation, usage enforcement |
| [ADR-0082](adr/0082-removal-of-unimplemented-features.md) | Features removed rather than shipped broken |
| [ADR-0083](adr/0083-post-acquisition-automation-pipeline.md) | Post-acquisition automation |

Diagrams: [pipeline architecture](diagrams/pipeline-architecture.md),
[scoring engine](diagrams/scoring-engine.md),
[provider abstraction](diagrams/provider-abstraction.md),
[deployment](diagrams/deployment.md),
[SaaS architecture](diagrams/saas-architecture.md).

## Configuration

- [Configuration reference](customization/configuration.md) — every
  environment variable, its default and its consequence
- [Data sources](data-sources.md) — which provider is free, which needs a
  key, which is Google Suggest or a local file
- [Trademark checklist](trademark-checklist.md) — what the gate checks and
  what it cannot

## API reference

The OpenAPI document is served by the running application and is the
canonical reference:

```bash
curl http://localhost:3000/api/v1/docs.json | jq .
```

or open `http://localhost:3000/api/v1/docs` for Swagger UI. The contract is
tested against the routers in CI: a documented-but-unimplemented operation
fails the build.
