# Self-hosting DOMINUS

The Community edition runs on a single machine at €0 infrastructure cost. This
page is the short path; [docs/deployment/README.md](../deployment/README.md) has
the full reference (reverse proxy, systemd, PM2, monitoring).

## Quick start (Docker Compose)

```bash
git clone https://github.com/AlessioBrillo/dominus.git && cd dominus
export API_KEYS="admin=$(openssl rand -hex 32)"
echo "$API_KEYS"          # the part after "admin=" is your login key
mkdir -p data             # the container runs as a non-root user
docker compose -f docker-compose.yml -f docker-compose.unbound.yml up -d
```

Open <http://localhost:3000> and sign in with the key.

- The `unbound` overlay adds a validating DNS resolver. Without it, domains are
  never reported as available (DNS is in degraded mode) and the first start waits
  about 30 seconds for a resolver that is not there.
- The API refuses to start on a public interface without `API_KEYS`.
- Data lives in `./data` (SQLite). Back it up with `dominus maintenance backup`;
  a daily backup also runs by itself.

## Configuration

Copy `.env.example` to `.env`. Every variable the program reads is listed there,
with its default, and a test keeps the file in sync with the code. You normally
need none of them. Useful ones:

| Variable                        | Why                                               |
| ------------------------------- | ------------------------------------------------- |
| `PUBLIC_APP_URL`                | your public origin (canonical URLs, invite links) |
| `EUIPO_CLIENT_ID/SECRET`        | enable the EUIPO side of the trademark gate       |
| `NAMEBIO_API_KEY`               | comparable sales for the market signal            |
| `SMTP_URL`, `NOTIFIER_EMAIL_TO` | email alerts                                      |

## Upgrading

```bash
git pull && docker compose -f docker-compose.yml -f docker-compose.unbound.yml up -d --build
```

Schema migrations run on start. Read the release's upgrade notes first
(`docs/releases/`) for removed or renamed settings.

## Moving to PostgreSQL / Cloud

Use `docker-compose.prod.yml` (PostgreSQL, Redis, Prometheus, Grafana) and
[the migration guide](../migration/community-to-cloud.md). The Community and
Cloud editions read the same schema.

## Supported deployment targets

Docker Compose, and the Terraform stack for a dedicated Hetzner node
(`deploy/terraform/`). Kubernetes manifests are not provided
([ADR-0082](../adr/0082-removal-of-unimplemented-features.md)).
