# Support

DOMINUS is a community-maintained open-source project with a managed cloud
offering. Here's how to get help.

## Documentation

- [README](README.md) — quick start, configuration, commands, editions comparison
- [Architecture Decision Records](docs/adr/README.md) — design rationale
- [Customization Guide](docs/customization/README.md) — adapting for your needs
- [Deployment Guide](docs/deployment/README.md) — infrastructure options
- [Roadmap](ROADMAP.md) — planned features and releases

## Getting Help

| Channel | Purpose | Audience |
|---------|---------|----------|
| [GitHub Issues](https://github.com/AlessioBrillo/dominus/issues) | Bug reports, feature requests | Community & Cloud users |
| [GitHub Discussions](https://github.com/AlessioBrillo/dominus/discussions) | Q&A, show and tell, ideas | Community & Cloud users |
| [Security](SECURITY.md) | Report vulnerabilities privately | All users |
| DOMINUS Cloud support | The support address published in the legal notice (`/legal-notice`) | Cloud subscribers |
| Commercial license inquiries | Enterprise licensing | Organizations |

### Response expectations

| Plan | Channel | First response |
| --- | --- | --- |
| Community (self-hosted) | GitHub Issues and Discussions | best effort, typically within 7 business days |
| DOMINUS Cloud — Pro | Email | 1 business day |
| DOMINUS Cloud — Team | Email + Slack | 1 business day |
| DOMINUS Cloud — Enterprise | named address in your order form | 4 business hours for severity 1 — see the [SLA](docs/operations/sla.md) |

There is no paid support tier for the community edition, and no SLA attaches
to it. Community support is what maintainers and users volunteer.

> The response times are a commitment to a person, not to a queue. The
> Enterprise first-response time is contractual; the Cloud tiers promise
> what a single maintainer can actually keep. If a paid tier ever needs a
> faster answer than the team can give, the answer is more people, not a
> smaller number in the table.

## Before Opening an Issue

1. Search [existing issues](https://github.com/AlessioBrillo/dominus/issues) — yours may already be reported
2. Check the `.env.example` — your question may be answered there
3. Review the relevant ADR in `docs/adr/` for design rationale
4. Check if your question is about the community edition (self-hosted) or
   DOMINUS Cloud (managed) — the answer may differ

## Filing a Bug

Include:
- DOMINUS version (`node dist/cli.js --version`)
- Edition (Community self-hosted or DOMINUS Cloud)
- Database backend (SQLite or PostgreSQL)
- Node.js version (`node --version`)
- Operating system
- Steps to reproduce
- Actual vs expected behaviour
- Relevant logs or error output

## Feature Requests

Feature requests are welcome. Please explain the use case and how the feature
would benefit the DOMINUS community. Provider implementations for new registrars,
trademark databases, or keyword sources are especially valuable.

Features that are exclusive to the managed infrastructure (multi-tenancy,
managed PostgreSQL, team accounts) are part of DOMINUS Cloud and may not be
available in the community edition — but the code itself remains open and
self-hostable.
