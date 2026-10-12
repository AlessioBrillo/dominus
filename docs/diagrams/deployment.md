# Deployment Architecture

## Docker Build

```mermaid
flowchart LR
    subgraph Build[Multi-Stage Docker Build]
        BASE["base<br/>node:22-alpine<br/>npm ci --production"]
        BUILD["build<br/>node:22-alpine<br/>npm ci + npm run build"]
        RUNTIME["runtime<br/>node:22-alpine (slim)<br/>dist/ + node_modules"]
    end

    subgraph Artifacts[Build Artifacts]
        DIST["dist/<br/>compiled JS + JSON assets"]
        WEB["dist/web/<br/>built SPA (dashboard)"]
        PROD_DEPS["node_modules/<br/>production only"]
    end

    subgraph Config[Runtime Configuration]
        ENV[".env file<br/>or environment variables"]
        DATA["data/<br/>keywords.json<br/>comps.csv (optional)"]
    end

    subgraph Storage[Data Storage]
        SQLITE[("/data/dominus.db<br/>SQLite file")]
    end

    BASE --> BUILD
    BUILD --> RUNTIME
    RUNTIME --> DIST
    RUNTIME --> WEB
    RUNTIME --> PROD_DEPS
    RUNTIME --> ENV
    RUNTIME --> DATA
    RUNTIME --> SQLITE

    style Build fill:#16213e,stroke:#0f3460,color:#eee
    style Artifacts fill:#0f3460,stroke:#533483,color:#eee
    style Config fill:#1a1a2e,stroke:#16213e,color:#eee
    style Storage fill:#2d1b69,stroke:#533483,color:#eee
```

`scripts/finalize-dist.mjs` runs after `tsc` to make the build output
complete across every distribution channel: it copies runtime JSON assets
(`tsc` drops non-`.ts` files), stages the compiled SPA at `dist/web/`, and
prunes the compiled test suites.

## Docker Compose (Community Edition)

```mermaid
flowchart LR
    INTERNET["Internet / LAN"]
    UNBOUND["unbound sidecar<br/>:5300 DNS (DNSSEC)"]
    DOMINUS["dominus-api<br/>:3000 (API + dashboard)"]
    WORKER["dominus-worker<br/>job queue consumer"]
    SCHED["dominus-scheduler<br/>cron jobs"]
    VOLUME[("dominus-data<br/>Docker volume<br/>/data/*.db")]

    INTERNET --> DOMINUS
    DOMINUS --> UNBOUND
    WORKER --> UNBOUND
    WORKER --> VOLUME
    SCHED --> VOLUME
    DOMINUS --> VOLUME

    style INTERNET fill:#1a1a2e,stroke:#16213e,color:#eee
    style DOMINUS fill:#0f3460,stroke:#533483,color:#eee
    style UNBOUND fill:#16213e,stroke:#0f3460,color:#eee
    style WORKER fill:#2d1b69,stroke:#533483,color:#eee
    style SCHED fill:#2d1b69,stroke:#533483,color:#eee
    style VOLUME fill:#2d1b69,stroke:#533483,color:#eee
```

```bash
# Community edition: SQLite + Unbound validating resolver
docker compose -f docker-compose.yml -f docker-compose.unbound.yml up -d
```

The Unbound overlay is not optional if you want "available" verdicts:
without a validating resolver the DNS stage degrades and never reports a
domain as available (ADR-0072, ADR-0076).

## Docker Compose (DOMINUS Cloud)

```mermaid
flowchart TB
    subgraph External[External]
        USERS["Users<br/>Browser / CLI / API"]
        CADDY["Caddy reverse proxy<br/>TLS termination"]
    end

    subgraph App[Application Node]
        API["dominus-api<br/>Express API + worker"]
        SCHED2["dominus-scheduler"]
    end

    subgraph Data[Managed Data Services]
        PG[("PostgreSQL<br/>HA / automated backups")]
        REDIS[("Redis<br/>rate-limit + lock store")]
        BLOB[("Object Storage<br/>off-host backups")]
    end

    subgraph Monitoring[Observability]
        PROM[Prometheus<br/>metrics scrape]
        AM[Alertmanager<br/>alert routing]
        GRAF[Grafana<br/>dashboards]
    end

    CADDY --> API
    USERS --> CADDY
    API --> PG
    API -.-> REDIS
    API --> BLOB
    API --> PROM
    PROM --> AM
    PROM --> GRAF

    style External fill:#1a1a2e,stroke:#16213e,color:#eee
    style App fill:#16213e,stroke:#0f3460,color:#eee
    style Data fill:#2d1b69,stroke:#533483,color:#eee
    style Monitoring fill:#0f3460,stroke:#16213e,color:#eee
```

```bash
# Cloud stack: PostgreSQL + Redis + Prometheus/Grafana + Unbound
docker compose \
  -f docker-compose.yml \
  -f docker-compose.unbound.yml \
  -f docker-compose.prod.yml up -d
```

Infrastructure-as-code for a dedicated node lives in
[`deploy/terraform/`](../../deploy/terraform/) (Hetzner app node, PITR
database node, and Caddy).

## Resource Requirements

| Edition | CPU | RAM | Storage | Cost |
|---------|-----|-----|---------|------|
| Community (Docker, SQLite) | 0.5 core | 256 MB | 1 GB (SQLite + data files) | ~€0 (existing hardware) |
| Cloud (Compose + PGSQL) | 1 core | 1 GB | 10 GB (PostgreSQL + backups) | ~€25-50/mo |
| Enterprise (Terraform) | 2+ cores | 2+ GB | 40 GB+ NVMe + object storage | on contract |

## Port Mapping

One HTTP port per deployment; there is no dedicated metrics port.

| Port | Protocol | Purpose | Notes |
|------|----------|---------|-------|
| `PORT` (default 3000) | HTTP | REST API + dashboard | bound to `127.0.0.1` by default in compose; expose deliberately |
| `PORT` (same) | HTTP | Prometheus metrics at `/api/v1/metrics/*` | optionally bearer-protected with `METRICS_TOKEN` |
| 5300 | TCP/UDP | Unbound resolver | internal compose network only |
| 9090 | HTTP | worker/scheduler healthcheck | loopback only, never exposed |
