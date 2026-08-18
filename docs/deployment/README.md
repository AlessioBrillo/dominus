# Deployment Guide

DOMINUS is designed to run anywhere — from a laptop to a Kubernetes cluster. Choose the option that fits your scale.

## Quick Start (Docker)

```bash
# Build and run (api + worker + scheduler — the full application)
docker compose up -d

# Production profile: GHCR images, resource limits, healthchecks, the
# full Cloud stack (PostgreSQL + Redis) and the monitoring stack
# (Prometheus + Alertmanager + Grafana)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

> The base compose file keeps PostgreSQL and Redis behind the `cloud`
> profile so community deployments stay single-container-file simple. The
> production profile clears that gate — the command above starts the
> complete stack. Worker and scheduler start by default in both variants.

The server listens on `http://localhost:3000` by default. Set `HOST=0.0.0.0` in `.env` to expose on all interfaces (required behind a reverse proxy).

## Immutable Deployments

The Deploy workflow publishes `master`, `sha-<commit>` and `vX.Y.Z` tags
to `ghcr.io/alessiobrillo/dominus` (with `-worker` / `-scheduler`
variants). The production compose profile references images through
`DOMINUS_IMAGE_TAG`:

```bash
# Rolling default (mutable — fine for personal use)
docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up -d

# Immutable production rollout — pin the exact commit you verified
DOMINUS_IMAGE_TAG=sha-6f4b3c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a \
  docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Resolve the tag for a released version with:

```bash
# Tags published for the latest commit on master
git fetch origin
git ls-remote --tags origin  # semantic version tags
DOMINUS_IMAGE_TAG=v0.10.0
```

Pinning to a `sha-` tag means the deployed artifact is immutable and
reproducible — you always know exactly which commit is running, and
rollback is a one-line `.env` change to a previously verified tag.

## Backups

The SQLite database lives at `DATABASE_PATH` (default: `./data/dominus.db`). **This file is your entire portfolio and configuration — back it up.**

```bash
# Built-in backup (VACUUM INTO) via the scheduler
#   SCHEDULER_ENABLED=true + SCHEDULER_BACKUP_CRON="0 4 * * *" (default)
# Manual backup
dominus maintenance backup ./backups/dominus-$(date +%Y%m%d).db

# Or with SQLite directly
sqlite3 data/dominus.db ".backup ./backups/dominus-$(date +%Y%m%d).db"
```

### Keeping backups off the DB disk

In the base and production compose profiles, the worker and scheduler
mount a dedicated `backups` volume at `/backups` (`BACKUP_DIR=/backups`).
The image pre-creates that mount point owned by the non-root `dominus`
user, so the volume works without extra chown steps.

The `backups` volume isolates backups from the `./data` volume that
holds the database. It still lives on the same host disk, so it protects
against accidental wipes and write amplification, not against disk
failure.

### Off-disk durability with a Hetzner Volume

For real off-disk durability on a self-managed VPS (e.g. Hetzner):

1. Create a Volume in the Hetzner Cloud console (same location as your
   VPS) and attach it to the server.
2. Mount it on the host and add it to `/etc/fstab`:
   ```bash
   mkfs.ext4 /dev/disk/by-id/scsi-0HC_Volume_<id>
   mkdir -p /mnt/dominus-backups
   mount /dev/disk/by-id/scsi-0HC_Volume_<id> /mnt/dominus-backups
   echo '/dev/disk/by-id/scsi-0HC_Volume_<id> /mnt/dominus-backups ext4 defaults,nofail 0 2' >> /etc/fstab
   ```
3. Point the backup volume at the mount:
   ```yaml
   # docker-compose.override.yml
   services:
     worker:
       volumes:
         - /mnt/dominus-backups:/backups
     scheduler:
       volumes:
         - /mnt/dominus-backups:/backups
   volumes:
     backups:
       external: false
   ```
   (or replace the `backups` named volume with the bind mount in your own
   compose override).
4. Add a periodic snapshot of the Volume from the Hetzner Cloud API
   (snapshot = off-site copy recoverable even if the VPS itself dies).
5. Test a restore at least once:
   ```bash
   # SQLite restore
   sqlite3 data/dominus.db ".restore /mnt/dominus-backups/dominus-<date>.db"
   # PostgreSQL restore (cloud mode)
   pg_restore --dbname=dominus /mnt/dominus-backups/dominus-<date>.db
   ```

Backup retention defaults to 30 days (`BACKUP_RETENTION_DAYS`) and the
scheduler prunes expired backups automatically.

### Restore drill

Backups are worthless until a restore has been proven. Run the drill at
least once per release — it takes the live database through the online
backup API, re-opens the copy, verifies `integrity_check` and compares
every table row count:

```bash
node scripts/restore-drill.mjs ./data/dominus.db
# restore-drill: OK - 52 tables, 123456 rows, integrity verified
```

Exit code 0 = green, 1 = red (do not ship). On a scheduled basis this can
be wired into the scheduler, but a manual run before each release is the
requirement.

### Point-in-time recovery (DOMINUS Cloud / PostgreSQL)

The daily `pg_dump` backup has an RPO of up to 24h. For the Cloud stack
(Dominus Cloud), PostgreSQL additionally ships with WAL archiving
(ADR-0054) so a restore can replay the database to *any* point in time:

- **WAL archiving** is enabled in `docker-compose.prod.yml`:
  `archive_mode=on` copies each switched segment into
  `PGDATA/archive` (inside the `pgdata` volume; `archive_timeout=300`
  forces a segment at least every 5 minutes of activity).
- **Base backups** anchor the archive. Run `deploy/postgres/base-backup.sh`
  daily on the host (cron/systemd timer, `pg_basebackup` from the
  postgresql-client package):
  ```bash
  crontab -e
  30 4 * * * PG_PASSWORD=<pass> /opt/dominus/deploy/postgres/base-backup.sh
  ```
  Base backups land in `$BACKUP_DIR/base-<timestamp>` next to the
  `pg_dump` files; the script prunes bases older than
  `PG_BASE_RETENTION_DAYS` (default 14).
- **Health**: the scheduler's `pitr-health` job (PostgreSQL only) polls
  WAL archiving lag every 15 minutes and the age of the newest base
  backup; Prometheus alerts `PitrWalLagHigh`, `PitrBaseBackupStale` and
  `BackupStale` (the latter fires whenever the daily dump has not
  succeeded for 26h — including a failed or silently skipped backup).
- **Restore**: `deploy/postgres/restore-base.sh <base-dir> <archive-dir>
  [recovery_target_time]` replays the archive into a fresh cluster on a
  spare port. Verify, then point `DATABASE_URL` at it and run
  `dominus maintenance vacuum`-style checks before promoting.

> **Trade-off (documented in ADR-0054):** the WAL archive shares the DB
> disk, so PITR protects against *logical* corruption (bad migration,
> accidental delete, buggy write) — the realistic failure mode — not
> against host death. If the VPS dies, the archive dies with it: ship
> the `backups` volume off-host (Hetzner Volume + snapshot, or object
> storage) and keep the daily `pg_dump` as the transportable artifact.

> **Never place `dominus.db` itself on a network filesystem** (NFS/SMB,
> Hetzner Volume, etc.). SQLite WAL mode is unsafe over network storage —
> the WAL/SHM coordination assumes a local POSIX filesystem and risks
> corruption under concurrent writes. Network storage is for *backups*
> only.

## SQLite Concurrency (community edition)

The community edition runs on SQLite in WAL mode. The API, worker and
scheduler all open the same `dominus.db` file (shared `./data` volume),
which SQLite supports on a local filesystem — with these limits:

- **One writer at a time.** WAL allows concurrent readers plus a single
  writer. Writes are serialized at the file-lock level; contention
  surfaces as `SQLITE_BUSY` and is absorbed by the 30s busy timeout
  (`DATABASE_BUSY_TIMEOUT`). High write throughput (many concurrent
  pipeline runs) degrades throughput rather than failing.
- **Long-lived readers stall WAL checkpoints.** A slow read transaction
  keeps the WAL growing. If you run long queries, keep them short and
  commit promptly.
- **Single-node only.** No network access to the DB and no horizontal
  write scaling — that is what PostgreSQL in cloud mode (`DATABASE_URL`)
  is for. Migrate with a single database dump when you outgrow SQLite.

If you see frequent `SQLITE_BUSY` errors, scale back concurrency (fewer
parallel runs, `WORKER_CONCURRENCY`) before considering PostgreSQL.

## DNS Resolution in Containers

The DNS pre-filter races multiple resolver legs (`doh-primary` by
default: Cloudflare/Google/Quad9 DoH, native fallback on error). Inside
a container the **native leg is the Docker embedded resolver
(127.0.0.11)** — a stub that forwards to the host's `/etc/resolv.conf`,
which on many hosts is systemd-resolved (127.0.0.53) with its own
negative cache and search domains. Consequences to know before choosing
`native`-inclusive strategies:

- **Stale negative cache.** A cached NXDOMAIN can serve "available" for
  a domain that just got registered. The app-level cache honours
  `forceRecheck` (used on closeout imports), but resolver-level caches
  are outside its control.
- **Search-domain mangling.** Single-label candidates can be rewritten
  by search domains into a "resolved" verdict — a false *registered*,
  which is the conservative direction (missed opportunity, never a
  wasted buy).
- **Disjointness is logical, not physical.** The consensus validator
  cannot see beyond 127.0.0.11; two strategies may share an upstream.
  The only topologically independent opinion is the pinned private
  recursor (see below).

For verdict integrity, prefer the co-hosted Unbound recursor
(ADR-0042) so the 2-of-3 consensus second leg is a real recursive
resolver on a private subnet, not the Docker stub:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.dns-consensus.yml up -d
```

The override is turnkey: it pins `consensus-dns` to 172.20.0.10 and
sets `DNS_CONSENSUS_NAMESERVERS=172.20.0.10:5300` +
`DNS_CONSENSUS_ENABLED=true` on api/worker/scheduler automatically.
Run `docker compose config --quiet` to validate the merged topology.

## Monitoring (production profile)

The prod compose profile ships a €0 self-hosted monitoring stack:

| Service | Role |
|---------|------|
| `prometheus` | Scrapes `http://api:3000/api/v1/metrics/prometheus` every 30s, 30-day retention |
| `alertmanager` | Routes alerts to the webhook in `deploy/prometheus/alertmanager.yml` |
| `grafana` | Provisioned dashboard "DOMINUS Overview" (`GRAFANA_ADMIN_PASSWORD` is **required** by the prod overlay — no default `admin/admin` credentials) |

Alert rules live in `deploy/prometheus/rules.yml` and cover: API down,
provider error rate > 25%, stage errors, stuck job queue (jobs queued with
no runner), queue backlog and new dead-letter jobs. Alertmanager does not
expand environment variables, so set the webhook URL inside
`deploy/prometheus/alertmanager.yml` before deploying.

The metrics endpoint is intentionally unauthenticated (same policy as
`/api/health`) but is only reachable on the Docker network — **do not
proxy `/api/v1/metrics/*` publicly** in your nginx/Caddy config.

## Redis Degradation (DOMINUS Cloud)

In cloud mode (`DATABASE_URL` set), Redis powers distributed rate
limiting, caching, circuit breakers and locks. The application treats
Redis as an availability optimization, not a hard dependency:

- `REDIS_REQUIRED` (defaults to `true` in cloud mode) only enforces that
  `REDIS_URL` is configured; it never probes connectivity.
- If Redis is down, every Redis-backed component (`RedisRateLimitStore`,
  `RedisRateLimiter`, `RedisCacheProvider`, `RedisLock`,
  `DistributedCircuitBreaker`) falls back to its in-memory equivalent
  and logs a warning — rate limiting stays enforced per-instance, the
  API keeps serving.
- The API refuses to boot only when `REDIS_URL` is missing while
  `REDIS_REQUIRED` is true (multi-instance split-brain protection).

Expected behaviour: with Redis down, per-IP limits still hold per
container but are no longer shared across replicas. Restore Redis and
the next operation resumes the shared counters automatically.

## Options

| Method | When to use | Commands |
|--------|-------------|---------|
| **CLI only** | Personal use, one-off scoring | `dominus run --closeout-csv candidates.csv` |
| **Docker** | Growing portfolio, REST API needed | `docker compose up -d` |
| **Docker + reverse proxy** | Public-facing API | Add nginx/Caddy in front |
| **systemd** | Bare-metal Linux server | `systemctl enable dominus` |
| **PM2** | Node.js process management | `pm2 start ecosystem.config.cjs` |
| **Kubernetes** | Enterprise, high availability | `kubectl apply -f deploy/` |

## Architecture

```
Internet ──► Reverse Proxy (nginx/Caddy) ──► DOMINUS (port 3000) ──► SQLite (data/dominus.db)
                                                      │
                                                      ├── CLI (direct access)
                                                      └── Scheduler (cron jobs)
```

## Reverse Proxy

### Nginx
Copy `docs/deployment/nginx.conf` to your nginx configuration directory, adjust the `server_name` and SSL certificate paths, then reload nginx:

```bash
sudo cp docs/deployment/nginx.conf /etc/nginx/sites-available/dominus
sudo ln -s /etc/nginx/sites-available/dominus /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Caddy
```caddyfile
dominus.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## Bare Metal

### systemd
```bash
sudo useradd -r -s /bin/false dominus
sudo mkdir -p /opt/dominus/data
sudo cp -r dist node_modules package.json /opt/dominus/
sudo cp docs/deployment/dominus.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dominus
```

### PM2
```bash
npm install -g pm2
cp docs/deployment/ecosystem.config.cjs .
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the instructions to enable boot-start
```

## Environment Variables

All configuration is via environment variables. See `.env.example` for the full reference.

Key variables for deployment:

| Variable | Default | Notes |
|----------|---------|-------|
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` behind reverse proxy |
| `PORT` | `3000` | Container port mapping |
| `DATABASE_PATH` | `./data/dominus.db` | Must be writable; use a volume mount in Docker |
| `API_KEYS` | (empty) | **Set this in production** to enable authentication |
| `SCHEDULER_ENABLED` | `false` | Enable for automated renewal checks, rescoring, pruning |
| `LOG_LEVEL` | `info` | Set to `warn` in production to reduce noise |
| `DOMINUS_IMAGE_TAG` | (required) | Compose-only (ADR-0046): no default — pin to `vX.Y.Z` or a `sha-…` tag for immutable rollouts; compose fails fast if unset |
| `BACKUP_DIR` | `./data/backup` | In the prod profile: `/backups` (dedicated volume) |

## Security Checklist

- [ ] Set `API_KEYS` to enable REST authentication
- [ ] Run behind a reverse proxy with HTTPS (TLS 1.2+)
- [ ] Restrict `HOST` to `127.0.0.1` unless proxied
- [ ] Set `RATE_LIMIT_MAX` to protect against abuse
- [ ] Use a non-root user (Docker: `USER dominus`, systemd: `User=dominus`)
- [ ] Set `DOMINUS_IMAGE_TAG` to a `vX.Y.Z` or `sha-…` tag in production (required, immutable rollouts — ADR-0046)
- [x] Keep backups off the DB disk (dedicated `backups` volume, ideally a Hetzner Volume or S3 target)
- [x] Test a backup restore at least once per release (`node scripts/restore-drill.mjs`)
- [ ] Keep `dominus.db` on local disk only — never on a network filesystem
- [ ] Do not proxy `/api/v1/metrics/*` publicly (internal monitoring only)
- [ ] Set `GRAFANA_ADMIN_PASSWORD` (production profile)
- [ ] Set the Alertmanager webhook URL in `deploy/prometheus/alertmanager.yml`
- [ ] Keep the `data/` directory in `.gitignore`
- [ ] Review logs periodically (`journalctl -u dominus`)
