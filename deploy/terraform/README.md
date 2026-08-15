# DOMINUS Cloud — Hetzner Infrastructure (v1.0.0)

Two-node provisioning for the managed hosting offering, aligned with the
cost discipline of ADR-0001/ADR-0026 (no managed database, no managed load
balancer):

| Node | Type  | Role |
|------|-------|------|
| `dominus-db`  | CX22 | PostgreSQL 17, PITR base backups + WAL archive to Backblaze B2 (ADR-0054) |
| `dominus-app` | CX32 | docker compose (api + worker + scheduler + redis) + Caddy reverse proxy |

Both nodes sit on a private network (`10.0.0.0/16`). The database listens
on the private address only; the public firewall admits 80/443 and SSH.
Caddy terminates TLS (Let's Encrypt) and proxies to the api container.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.6
- A Hetzner Cloud API token
- An SSH key pair (private key stays local)

## Quick start

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars          # token, key, domain, secrets
terraform init
terraform plan
terraform apply
```

`terraform apply` prints the app public IP / URL. If `domain` is set, a
Hetzner DNS zone is created and the A record points at the app node —
point the domain's NS records at Hetzner DNS first (or create the record
at your existing registrar; the app works either way).

## Secrets

`terraform.tfvars` holds the Hetzner token, DB password, B2 keys and app
secrets (`API_KEYS`, `STRIPE_*`, `JWT_SECRET`). It is gitignored and never
committed. Values are rendered into cloud-init `user_data` at apply time;
Hetzner stores user_data per server (standard practice — the values are
also visible to anyone with Hetzner console access, so keep the token
scope tight).

For team operation, move the state to Backblaze B2 (S3-compatible backend,
the commented block in `main.tf`) instead of the local default.

## Backups and PITR

- Daily base backup at 04:30 (cron on the db node) — `base-backup.sh`
  fetched from the repo at the pinned `image_tag`
- WAL archiving to `b2:<bucket>/wal` when `b2_backup.enabled = true`
  (otherwise `archive_mode = off` — an unreachable archive stalls Postgres)
- Restore drill: `scripts/restore-drill.mjs` + `deploy/postgres/restore-base.sh`

## Updating the deployment

```bash
# bump image_tag in terraform.tfvars, then:
terraform plan && terraform apply
```

The app node's systemd unit pulls the new tag on next boot
(`docker compose up -d --pull always`); the db node intentionally ignores
`user_data` changes to avoid destructive recreates — rotate DB secrets via
SSH + `ALTER ROLE` instead.

## Validation

`.github/workflows/iac.yml` runs `terraform fmt`, `terraform init
-backend=false`, `terraform validate` and a YAML smoke-render of both
cloud-init templates on every PR touching `deploy/terraform/`.