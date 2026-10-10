# Upgrading to 1.1.0

1.1.0 fixes isolation and PostgreSQL bugs found in the pre-release audit and
removes features that were declared but never worked. Read **Breaking changes**
before upgrading a Cloud deployment.

## Breaking changes

| Change                                                                                                                                                                                                                          | Who is affected                           | What to do                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **`/admin` requires the `operator` role.** It is granted only by the new `OPERATOR_SUBJECTS` allowlist; tenant `admin` keys no longer reach the operator panel.                                                                 | Cloud operators                           | Set `OPERATOR_SUBJECTS` (OIDC `sub` and/or `key:<id>`) and restart. Until then nobody can open `/admin`. |
| **`METRICS_TOKEN` is required in Cloud mode.** The server refuses to start without it.                                                                                                                                          | Cloud                                     | Set `METRICS_TOKEN` and add the matching bearer token to the Prometheus scrape config.                   |
| **Domain uniqueness is per tenant** (migration 0058 rebuilds `candidates`, `portfolio_entries`, `watchlist_entries`, `outcome_scores`, `renewal_alerts`, `listings`). `outcomes.domain` loses its foreign key to the portfolio. | Everyone                                  | Automatic on start. Take a backup first; the migration rebuilds tables.                                  |
| **Run history is per tenant** (migration 0059). Existing runs are assigned to the `default` tenant.                                                                                                                             | Cloud with prior runs                     | None required; reassign rows by SQL if you need them under another tenant.                               |
| **`POST /runs/prune` requires `admin` and prunes only the caller's tenant.** New `DELETE /runs/:id`.                                                                                                                            | API users                                 | Use an admin key.                                                                                        |
| **Team invites are sent by email** (`POST /team/invite {email, role}`); invitations hold a seat. The user-id form still works but nobody can accept it.                                                                         | Cloud teams                               | Use the Team page. Optional `SMTP_URL` emails the link.                                                  |
| **`POST /auth/oidc/logout` returns `{ logoutUrl }`** (was 204) and rejects requests from untrusted origins.                                                                                                                     | Custom frontends                          | Navigate to `logoutUrl`; make sure the request carries a trusted `Origin` (`CORS_ORIGIN`).               |
| **Cookie-authenticated writes need a trusted `Origin`/`Referer`.**                                                                                                                                                              | Custom frontends using the session cookie | Serve the SPA from `CORS_ORIGIN` or the OIDC callback origin.                                            |
| **Environment-key (Community) callers have the `admin` role** of the default tenant.                                                                                                                                            | Community                                 | None.                                                                                                    |

## Removed

- **Per-query DNSSEC** (`DNS_PER_QUERY_DNSEC*`): it never validated anything. DNSSEC
  stays enforced by Unbound.
- **DoH fallback providers**: `DNS_FALLBACK_PROVIDER` accepts only `node-dns`.
- **Dan.com, Afternic and Sedo listing adapters** and `DAN_API_KEY`,
  `AFTERNIC_API_*`, `SEDO_API_*`: `LISTING_PROVIDER` accepts only `manual`.
- `docker-compose.dns-consensus.yml` and the `DNS_CONSENSUS_*` / `DNS_TERTIARY_*`
  variables. Use `docker-compose.unbound.yml` (`DNS_UNBOUND_HOSTS`). The Terraform
  cloud-init was updated accordingly: re-render it before the next `apply`.
- Kubernetes manifests (`deploy/*.yaml`). Supported targets: Docker Compose and
  Terraform/Hetzner.
- Documented-but-unread variables in `.env.example`: registrar credentials other
  than Cloudflare, `DNS_CIRCUIT_BREAKER_*`, `DNS_DOH_*`, `DNS_NAMESERVERS`,
  `DNS_PRIVACY_MODE`, `DNS_RESOLVER_GROUPS`, `DNS_LOOKUP_STRATEGY`,
  `SCORING_CONFIDENCE_PER_SIGNAL`.

See [ADR-0082](../adr/0082-removal-of-unimplemented-features.md).

## Added

- Email team invitations, SSO sign-in resolved from team seats, API key
  management in Settings, alert dismissal on the Dashboard
  ([ADR-0081](../adr/0081-operator-role-and-team-invitations.md)).
- Optional SMTP (`SMTP_URL`, `SMTP_FROM`) and an email alert channel
  (`NOTIFIER_EMAIL_TO`).
- `OIDC_AUTO_PROVISION_TENANTS` (default `false`): set it to `true` for self-serve Cloud signup; otherwise a user with no team seat is rejected until invited.
- `GET /api/v1/me`.
- PostgreSQL portability checks and a CI job that runs the suite on PostgreSQL.
- WCAG 2.1 AA gate (axe) in the E2E suite; accessible colour tokens.
- Docker images: `vX.Y.Z`, `vX.Y.Z-worker`, `vX.Y.Z-scheduler` tags are now
  distinct; the API image serves the public-page CSS and binds `0.0.0.0`.

## Known limits

- No tenant switcher: a user in several teams lands in the most recently joined.
- Accepting an invitation needs an identity provider that returns a verified `email` claim.
- Row-level security covers the entity tables; control-plane tables (keys,
  subscriptions, usage, seats, invitations) are scoped by the application.
