# DOMINUS Cloud — Hetzner Infrastructure (v1.0.0)

Two-node provisioning for the managed hosting offering, aligned with the
cost discipline of ADR-0001/ADR-0026 (no managed database, no managed load
balancer):

| Node | Type  | Role |
|------|-------|------|
| `dominus-db`  | CX22 | PostgreSQL 17, PITR base backups + WAL archive to Backblaze B2 (ADR-0054) |
| `dominus-app` | CX32 | docker compose (api + worker + scheduler + redis) + Caddy reverse proxy |

Both nodes sit on a private network (`10.0.0.0/16`). The database listens
on the private address only; the public firewall admits 80/443 and SSH —
and SSH only from the operator's own networks unless the exposure is
accepted explicitly. Caddy terminates TLS (Let's Encrypt) and proxies to
the api container. The app connects as the `dominus_app` role — never
the owner, whose superuser-level rights would bypass
`FORCE ROW LEVEL SECURITY` (ADR-0038/0047).

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

Two things in that sequence are not optional dressing. The first apply
runs against a **local** state file, which is a plaintext copy of the
deployment's secrets (see [Remote state](#remote-state)) — move it off
the machine before there is a second apply to lose. And the apply is
**refused** until the SSH ingress decision is written down (see
[SSH ingress](#ssh-ingress)).

## Secrets

`terraform.tfvars` holds the Hetzner token, DB passwords, B2 keys and app
secrets (`API_KEYS`, `STRIPE_*`, `JWT_SECRET`). It is gitignored and never
committed. Values are rendered into cloud-init `user_data` at apply time;
Hetzner stores user_data per server (standard practice — the values are
also visible to anyone with Hetzner console access, so keep the token
scope tight).

The **state** is the other half of the secret surface, and the larger
one: it carries every secret that is rendered into the nodes' cloud-init
— the three database passwords, the B2 application key and the whole
`app_env` map — because Terraform keeps the rendered `user_data` of both
servers in it, and it is rewritten by every apply. A local
`terraform.tfstate` is therefore a secret store on a laptop that can be
lost, stolen or swept into a backup service. Treat the state backend
like the `terraform.tfvars` file: a place secrets are allowed to live,
with an owner and a rotation, not a scratch file.

(The Hetzner API token is a provider credential and is *not* persisted
in the state — but it sits in `terraform.tfvars` on the same machine, so
the machine holds the whole set either way.)

Three DB roles are provisioned with distinct passwords (`db_password`,
`db_backup_password`, `db_app_password`): the `backup` role (`REPLICATION`
only, used by the PITR cron via the 0600 `/opt/dominus/backup.env`) never
shares a credential with the owner role or the app role.

Rotating any of these is a manual operation, not a `terraform apply`:
the nodes carry `ignore_changes = [user_data]`, so a new password in
`terraform.tfvars` never reaches the running database. The runbook is
[docs/operations/secrets.md](../../docs/operations/secrets.md).

## Remote state

`backend.hcl.example` is a ready-to-copy Backblaze B2 (S3-compatible)
backend block — B2 is the cost-free option and the state bucket is the
only thing in the deployment that must outlive the machine that created
it:

```bash
cd deploy/terraform
cp backend.hcl.example backend.hcl
$EDITOR backend.hcl                 # bucket, key prefix, credentials
terraform init -backend-config=backend.hcl
```

`backend.hcl` **must be gitignored**, exactly like `terraform.tfvars`:
it names the state bucket and, if the credentials are written into it,
the access key that can read and write the state. The example prefers
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the shell over
credentials in the file, so the file holds only the bucket coordinates.
`deploy/terraform/.gitignore` covers `terraform.tfvars` and the state
files but not `backend.hcl` — add it there before you create the file.

The state contains the deployment's secrets — the three database
passwords, the B2 key and the whole `app_env` map — so it is a secret
store in practice, and access to the bucket is access to all of them.
Use a B2 application key scoped to that one bucket, and rotate it like
any other secret
([secrets.md](../../docs/operations/secrets.md)).

## SSH ingress

The firewall rules for port 22 are **closed by default**. `ssh_allowed_cidrs`
is empty and an apply with an empty allowlist is refused by a precondition
on both firewalls, because an SSH port open to the whole internet is a
standing invitation, and a permissive default that "existing deployments"
depend on is a default that never gets restricted. The decision is
recorded in the state instead of being made by omission.

| Configuration | Effective SSH ingress | Posture |
|---|---|---|
| `ssh_allowed_cidrs = ["203.0.113.10/32"]` | the operator's networks only | recommended once the deploy runner has a static egress IP |
| `allow_public_ssh = true` | `0.0.0.0/0`, `::/0` — any address | key-only SSH, fail2ban throttles the guessing; a compromised operator key is world-reachable |

Both firewalls read the same resolved list, so the precondition and the
applied rule can never disagree about what is admitted.

Caveat: the release pipeline (`deploy.yml`) reaches the app node over SSH
from GitHub Actions runners whose egress IPs are dynamic, so restricting
the **app** node needs a static-egress runner or another deploy
transport. The **db** node (operator-only SSH) can be restricted freely.
Until the runner has a static address, `allow_public_ssh = true` is the
deliberate choice — and it is a choice, in the state, that a reader can
see.

## Backups and PITR

- Daily base backup at 04:30 (cron on the db node) — `base-backup.sh`
  fetched from the repo at the pinned `image_tag`, connecting as a
  dedicated `backup` role (`REPLICATION` only — least privilege, never
  the app role). The cron line sources `/opt/dominus/backup.env` (0600,
  postgres-owned) so no secrets appear in `/etc/cron.d`; output appends
  to `/var/log/dominus/base-backup.log`
- The base anchor is copied off-host to `b2:<bucket>/base/` when
  `b2_backup.enabled = true` (same rclone remote as the WAL archive),
  pruned with the same 14-day retention as local. A base backup that
  dies with the node is no PITR anchor at all
- WAL archiving to `b2:<bucket>/wal` when `b2_backup.enabled = true`
  (otherwise `archive_mode = off` — an unreachable archive stalls
  Postgres)
- Restore: `rclone copy b2:<bucket>/base/<base-...> <dir>` to pull an
  off-host anchor, then `scripts/restore-drill.mjs` +
  `deploy/postgres/restore-base.sh`

## Updating the deployment

```bash
# bump image_tag in terraform.tfvars, then:
terraform plan && terraform apply
```

The app node's systemd unit pulls the new tag on next boot
(`docker compose up -d --pull always`); the db node intentionally ignores
`user_data` changes to avoid destructive recreates — rotate DB secrets via
SSH + `ALTER ROLE` instead, following
[docs/operations/secrets.md](../../docs/operations/secrets.md).

## Validation

`.github/workflows/iac.yml` runs `terraform fmt`, `terraform init
-backend=false`, `terraform validate` and a YAML smoke-render of both
cloud-init templates on every PR touching `deploy/terraform/`. The smoke
render also verifies the rendered app compose mounts the `backups` volume
on the worker and scheduler (`BACKUP_DIR=/backups`, see
`.env.example`) and that the alertmanager webhook placeholder is
substituted from `alertmanager_webhook_url` (mirror of the module's HCL
replace chain — a node that keeps the example.com URL alerts nowhere).