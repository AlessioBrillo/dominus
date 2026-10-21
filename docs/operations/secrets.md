# Secret rotation

Status: **documented** (v1.3.0)
Scope: DOMINUS Cloud — Terraform state, cloud-init secrets, PostgreSQL roles
Related: [Terraform (Hetzner)](../../deploy/terraform/README.md), [RTO / RPO](rto-rpo.md), [Incident response](incident-response.md), [Launch checklist](../releases/launch-checklist.md)

Every credential of a DOMINUS Cloud deployment is a value that two or
three places know about at once: the database, a file on a node, and
the Terraform configuration that provisioned it. Rotating one means
changing all of them in the same window, and the runbook exists because
the order in which that happens decides whether a customer sees an
error or a scheduled job does.

## 1. What holds what

| Secret | Live location | In the state | Rotate with |
|---|---|---|---|
| `hcloud_token` | `terraform.tfvars` | no — a provider credential is not persisted | console → new token → `terraform.tfvars` → apply |
| `hetzner_dns_token` | `terraform.tfvars` | no — a provider credential is not persisted | console → new token → `terraform.tfvars` → apply |
| `dominus` password (`db_password`) | PostgreSQL role `dominus`; `/opt/dominus/backup.env` (`PITR_MANIFEST_PASSWORD`) | yes (rendered `user_data`) | `ALTER ROLE` over SSH + edit `backup.env` |
| `backup` password (`db_backup_password`) | PostgreSQL role `backup`; `/opt/dominus/backup.env` (`PG_PASSWORD`) | yes (rendered `user_data`) | `ALTER ROLE` over SSH + edit `backup.env` |
| `dominus_app` password (`db_app_password`) | PostgreSQL role `dominus_app`; `/opt/dominus/.env` on the app node (`DATABASE_URL`) | yes (rendered `user_data`) | `ALTER ROLE` over SSH + edit the app `.env` + recreate the containers |
| `app_env` (`JWT_SECRET`, `STRIPE_SECRET_KEY`, `API_KEYS`, …) | `/opt/dominus/.env` on the app node | yes (the whole map) | edit the app `.env` + recreate the containers |
| B2 application key (`b2_backup.application_key`) | `/var/lib/postgresql/.config/rclone/rclone.conf` on the db node | yes | B2 console → new key → `rclone.conf` |
| B2 state-bucket key (`backend.hcl`) | the developer's shell / `backend.hcl` | the state it protects | B2 console → new key → `backend.hcl` |
| operator SSH public key (`ssh_public_key`) | `~/.ssh/authorized_keys` on both nodes | yes | `terraform apply` (it is a managed resource) |

## 2. The rule that shapes every rotation

**The db node's cloud-init is not re-applied.** `hcloud_server.db`
carries `lifecycle { ignore_changes = [user_data] }`
(`deploy/terraform/modules/db-node/main.tf`): a new password in
`terraform.tfvars` renders a new cloud-init, Terraform sees the
difference and deliberately ignores it, because recreating a node that
holds the production database is not an acceptable way to change a
password. The app node carries the same `ignore_changes` for the same
reason (its named volumes hold the data).

Three consequences, and every step below follows from them:

1. **Rotation is out-of-band.** The database is changed with
   `ALTER ROLE` over SSH, and the files on the nodes are edited by
   hand. A `terraform apply` does not rotate anything; it is not even
   the right tool for the job.
2. **The state is a secret store.** The state carries the rendered
   `user_data` of both servers — the three database passwords, the B2
   application key and the whole `app_env` map, as they were at
   provisioning — and **every apply rewrites it**. Anyone who can read
   the state can read those secrets. It is not a plan cache: it is a
   secret file with an infrastructure-shaped filename. Access to the
   state bucket is a credential, its backups are secret backups, and its
   rotation is the rotation of everything inside it. Note the
   consequence of the `ignore_changes` above: a rotation performed out
   of band does **not** update the state (the attribute is ignored), so
   the state keeps the previous values until the node is replaced. They
   are worthless credentials by then, but they are still secret
   material sitting in a bucket.

   The Hetzner API token is not among them — a provider credential is
   not persisted in the state — but it is in `terraform.tfvars` on the
   same machine, so the machine holds the whole set either way.
3. **`terraform.tfvars` is half of the rotation.** A value that lives
   only in the live node is lost at the next node replacement: the new
   node is provisioned from `terraform.tfvars` and comes up with the
   old password. Write the new value into `terraform.tfvars` first,
   rotate the live side, and the two halves stay in step.

Two rules that are not specific to any secret:

- **One secret at a time.** Rotate, verify, then rotate the next. A
  rotation that touches three credentials at once has no bisect.
- **Do not revoke before the replacement works.** Create the new key,
  deploy it, prove it, and only then delete the old one. The Stripe
  and B2 dashboards both allow several keys to be live at the same
  time; use that.

## 3. The three PostgreSQL roles

| Role | Rights | Used by | Password lives in |
|---|---|---|---|
| `dominus` | owner of the `dominus` database | the PITR manifest writer, operator `psql -U dominus` sessions | `backup.env` → `PITR_MANIFEST_PASSWORD` |
| `backup` | `REPLICATION` only — no read access to the data | the daily PITR cron (`pg_basebackup`) | `backup.env` → `PG_PASSWORD` |
| `dominus_app` | the RLS-scoped application role | the api, worker and scheduler containers **and the migration step** (`migrate.sh` inherits the api service environment, so the schema is migrated as the app role) | the app node's `.env` → `DATABASE_URL` |

The app must never connect as the owner: an owner bypasses `FORCE ROW
LEVEL SECURITY` (ADR-0038/0047), and tenant isolation would rest on
application filters alone. The three roles therefore hold three
different passwords, and the backup role never shares a credential with
either of the others — a leak of `/opt/dominus/backup.env` must not
open the data.

### The order

1. **`backup`** — no live traffic depends on it; the only consumer is
   the 04:30 cron, and a mistake is caught by a job, not by a
   customer.
2. **`dominus`** (owner) — the same cron writes the PITR manifest with
   it, and every operator's `psql -U dominus` uses it.
3. **`dominus_app`** — the running stack connects with it. This is the
   only rotation with a customer-visible window, so it goes last, with
   the whole chain in one command.

The order is "least exposed first, live traffic last": the credentials
no request touches are rotated while the only witness is a scheduled
job, and the one that interrupts traffic is rotated when the operator
is watching for it.

### The commands

Generate the new value where it is used. Use a hexadecimal or
alphanumeric password: the app's `DATABASE_URL` embeds it in a URL, and
a password containing `@ : / ? # %` breaks the URL or the shell
quoting of every command below.

```bash
ssh root@<db-node-ip>
openssl rand -hex 24        # 48 hex characters, no quoting hazards
```

Change the role. `\password` prompts for the value, never echoes it
and never writes it to the shell history or the process list:

```bash
sudo -u postgres psql                    # interactive session
psql> \password backup
Enter new password for user "backup":
psql> \password dominus
Enter new password for user "dominus":
psql> \quit
```

(`ALTER ROLE backup WITH PASSWORD '…'` is the scripted alternative: it
works, but it puts the secret in the shell history and in the process
list of the node.)

Update the file the cron reads. It is `0600` and postgres-owned, so
the edit must run **as postgres** — a `sed -i` performed as root
replaces the file and leaves it root-owned, the cron can no longer read
it, and the daily backup dies silently:

```bash
sudo -u postgres sed -i \
  -e 's|^PG_PASSWORD=.*|PG_PASSWORD=<new-backup-password>|' \
  -e 's|^PITR_MANIFEST_PASSWORD=.*|PITR_MANIFEST_PASSWORD=<new-owner-password>|' \
  /opt/dominus/backup.env
```

Prove both credentials with one run of the backup script: it connects
as `backup` for `pg_basebackup` and as `dominus` for the manifest
insert — and, when the off-host archive is enabled, it exercises the B2
key too.

```bash
sudo -u postgres bash -c 'set -a; . /opt/dominus/backup.env; set +a; /opt/dominus/base-backup.sh'
tail -n 20 /var/log/dominus/base-backup.log
```

`base-backup: done` means the `backup` credential works; a
`base-backup: PITR manifest recorded` line means the owner credential
works too. A missing manifest line with a successful backup means the
owner password is wrong — the backup still runs, and the pitr-health
alert is the only thing that notices.

Now the application role, on the db node and then on the app node.
The order inside is deliberate: PostgreSQL authenticates at connect
time, so the connections already open keep working after `ALTER ROLE`
while every *new* connection with the old password fails. The window
is the time between the two commands, so it is kept to seconds.

```bash
# db node
sudo -u postgres psql -c "ALTER ROLE dominus_app WITH PASSWORD '<new-app-password>';"

# app node, immediately after
cd /opt/dominus
sed -i 's|^DATABASE_URL=.*|DATABASE_URL=postgres://dominus_app:<new-app-password>@10.0.0.3:5432/dominus?sslmode=require|' .env
docker compose up -d --force-recreate api worker scheduler
curl -fsS http://127.0.0.1:3000/api/health
```

(`docker compose up -d` alone is normally enough — compose recreates a
container whose environment changed — but `--force-recreate` removes
the doubt, and the health check is the proof that the new password was
accepted.)

Finally, write all three new values into `terraform.tfvars`
(`db_password`, `db_backup_password`, `db_app_password`) and apply, so
the next provisioning carries them:

```bash
cd deploy/terraform
terraform plan && terraform apply
```

The plan is empty for the nodes — `user_data` is ignored, so the apply
changes nothing on the machines and the state is rewritten with the
`user_data` it already held. A node replacement from here on comes up
with the new passwords; until then the state still carries the old
ones, which is why the state bucket stays a secret store and not a
history of what used to be true.

## 4. The application environment (`app_env`)

`app_env` is rendered verbatim into `/opt/dominus/.env` on the app node
(`0600`) and consumed by the api, worker and scheduler containers. The
same map sits in the state in full. The three classes in it do not have
the same blast radius, and the difference decides when a rotation is
acceptable:

| Key | What the rotation costs |
|---|---|
| `JWT_SECRET` (and the SSO client secret) | **Every OIDC session dies.** ADR-0062 signs the SSO session cookie with a key derived (HKDF) from the operator's client secret: change the signing material and every open session fails verification at the same instant — a mass logout, with no per-session revocation list to soften it. `JWT_SECRET` belongs to that class of material: rotate it in a window and expect every browser to land on the login page. |
| `STRIPE_SECRET_KEY` | **A restart, and nothing else.** The key is read per request, so a rotated key only needs the containers to pick up the new value: update `/opt/dominus/.env`, `docker compose up -d --force-recreate api worker scheduler`. No session is affected and no customer is logged out. Do not recreate the api in the middle of a checkout — a payment in flight fails. |
| `API_KEYS` | **The clients, immediately.** The key is compared verbatim on each request, so the old key stops working the moment it is changed — no restart, no session invalidation. Rotate it when the client (a script, a partner integration) can be switched in the same minute; `API_KEYS` accepts several named keys (`name=key,name2=key2`), so keep the old one alive until the client is switched. **This is the community edition's key (`AUTH_PROVIDER=env`).** In the Cloud edition (`AUTH_PROVIDER=db`) the key material lives in the `api_keys` table, hashed with scrypt, and `API_KEYS` is not read at all: the keys are minted with `dominus keys create --tenant <id>` and rotated by creating a new key and revoking the old one. |

The two names in the first row matter, because the deployment carries
both and the application reads only one of them: the SSO session cookie
is signed from `AUTH0_CLIENT_SECRET` (ADR-0062 — `.env.example` warns
about exactly this), while the API-key path compares `API_KEYS` verbatim
(ADR-0017 chose it over JWT bearer tokens, so `JWT_SECRET` is not read
by the shipped code at all). The kill-switch for the SSO flow is
therefore `AUTH0_CLIENT_SECRET` — check the deployment's `app_env` for
it before assuming that a rotation of the other name did the job.

The file to edit is the app node's `/opt/dominus/.env`; the same values
must be written into the `app_env` map in `terraform.tfvars` and applied,
or a re-provisioned node comes up without them.

## 5. The B2 application key

Two B2 credentials exist and they are not interchangeable: the PITR
bucket key (`b2_backup.application_key` in `terraform.tfvars`, used by
the WAL archiver and the base-backup cron) and the state-bucket key
(`backend.hcl`). Scope each one to the single bucket it serves, and
never use the account master key for either.

The PITR key lives in the rclone config in the postgres user's home, so
that both the WAL archiver and the backup cron can use it:

```
/var/lib/postgresql/.config/rclone/rclone.conf    (0600, postgres-owned)

[b2]
type = b2
account = <account id>
key = <application key>
endpoint = https://s3.eu-central-003.backblazeb2.com
```

Rotate it on the db node, again **as postgres** — a root-owned
`rclone.conf` is unreadable by the WAL archiver, and a stalled archiver
is a node that silently falls behind on WAL while still looking healthy:

```bash
sudo -u postgres sed -i 's|^key = .*|key = <new-application-key>|' \
  /var/lib/postgresql/.config/rclone/rclone.conf
sudo -u postgres rclone lsd b2:<bucket>/            # proves the credential
sudo -u postgres rclone lsd b2:<bucket>/wal/        # the archive prefix
```

`rclone config update b2 key <value>` is the alternative, but it
rewrites the whole file (and stores the key obscured, in a different
format from the one cloud-init wrote) — so the ownership and the mode
have to be put back afterwards: `chown postgres:postgres` and `chmod 600`
on `/var/lib/postgresql/.config/rclone/rclone.conf`.

The endpoint in the config names the region of the **PITR** bucket,
which is not necessarily the region of the state bucket (`us-east-005`
in `backend.hcl.example`): two buckets, two regions, two endpoints.

No restart is needed for the archiver to pick the new key up — rclone
is invoked per WAL segment and reads the file every time — but the
archiver must be seen to be keeping up:

```bash
sudo -u postgres psql -c "SELECT archived_count, last_archived_wal, failed_count FROM pg_stat_archiver;"
```

Then update `b2_backup.application_key` in `terraform.tfvars` and apply,
so that a node replacement from here on comes up with the new key (the
apply does not touch the node — `user_data` is ignored, and the state
keeps the key it already held).

The state-bucket key is rotated the same way: create a new B2
application key scoped to the state bucket, put it in `backend.hcl` (or
in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the shell), run
`terraform init -backend-config=backend.hcl && terraform plan` to prove
it can read the state, and only then delete the old key in the B2
console. `backend.hcl` is a secret file and must be gitignored.

## 6. The Hetzner API token

`hcloud_token` is the credential that can create and destroy both
nodes. It lives in `terraform.tfvars` (not in the state — a provider
credential is not persisted), and how it is scoped is the difference
between a leak and an incident:

- **Project scope.** A Hetzner Cloud API token belongs to exactly one
  Cloud Project and sees nothing in the others. Put DOMINUS in a
  project of its own, so a leaked token cannot reach unrelated
  infrastructure in the same account.
- **Permission scope.** A token is either *Read* or *Read & Write*.
  Terraform needs Read & Write to create servers, firewalls and
  networks; a *Read* token is enough to review a plan, and it is the
  right credential for a second pair of eyes that should not be able to
  change anything.
- **Location scope.** The token is needed only where Terraform runs (a
  plan or an apply) — the operator's machine, or a CI runner that holds
  it as a secret. It is never needed on a node: the release pipeline
  reaches the app node with an SSH key, not with the Cloud API.
- **Separate the DNS credential.** `hetzner_dns_token` talks to a
  different API and cannot touch the Cloud API at all. Leave it empty
  when the A record is managed at an external registrar, and give it
  only to the process that writes the record.

Rotation:

```bash
# 1. console: Security → API Tokens → generate a new Read & Write token
#    in the DOMINUS project
# 2. write it into terraform.tfvars
terraform plan          # a wrong token fails here, before anything changes
terraform apply
# 3. console: delete the old token
```

The old token is deleted last, after an apply has proved the new one
works. The plan is empty (a token is not a resource attribute) — what
the plan proves is that the provider authenticated and refreshed the
state with the new credential.

## 7. Closing the rotation

A rotation is not finished when the new value works; it is finished
when the gate says the deployment is still launchable:

```bash
# on the app node, with the deployment's environment loaded
set -a; . /opt/dominus/.env; set +a
npm run launch:check -- --url https://dominus.example
```

`npm run launch:check` is the mechanical half of the
[launch checklist](../releases/launch-checklist.md): it refuses to
declare a deployment launchable while the legal identity, the metrics
token, the backup configuration, the Stripe configuration or the
webhook secret are missing or still placeholders. A rotation must not
change its verdict — the same exit code as before the rotation, 0 if it
was 0. A rotation that turns the gate red is a broken rotation, not a
new baseline.

The rest of the closing checks:

- the health endpoint answers (`curl -fsS http://127.0.0.1:3000/api/health`);
- the next PITR run logs a completed base backup, and — if the B2 key
  was rotated — a completed off-host copy to `b2:<bucket>/base/`;
- `docker compose ps` on the app node shows the containers that were
  recreated with the new environment;
- `terraform.tfvars` and the live nodes agree: the value in the file is
  the value in use, and the state is where it should be (a remote
  backend, not a laptop).

That last point is the one worth repeating: the Terraform state is
rewritten by every apply, so the state is a secret store in practice.
Whoever holds the state bucket holds the database passwords, the B2 key
and the application secrets as they were provisioned; that is a
credential to rotate and to audit, not a file to forget.
