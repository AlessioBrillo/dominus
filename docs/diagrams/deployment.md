# Deployment Architecture

## Docker Build

```mermaid
flowchart LR
    subgraph Build[Multi-Stage Docker Build]
        BASE["base<br/>node:20-alpine<br/>npm ci --production"]
        BUILD["build<br/>node:20-alpine<br/>npm ci + npm run build"]
        RUNTIME["runtime<br/>node:20-alpine (slim)<br/>dist/ + node_modules"]
    end

    subgraph Artifacts[Build Artifacts]
        DIST["dist/<br/>compiled JS"]
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
    RUNTIME --> PROD_DEPS
    RUNTIME --> ENV
    RUNTIME --> DATA
    RUNTIME --> SQLITE

    style Build fill:#16213e,stroke:#0f3460,color:#eee
    style Artifacts fill:#0f3460,stroke:#533483,color:#eee
    style Config fill:#1a1a2e,stroke:#16213e,color:#eee
    style Storage fill:#2d1b69,stroke:#533483,color:#eee
```

## Docker Compose (Community Edition)

```mermaid
flowchart LR
    INTERNET["Internet / LAN"]
    DOMINUS["dominus-server<br/>:8080 (API)<br/>:8081 (metrics)"]
    VOLUME[("dominus-data<br/>Docker volume<br/>/data/*.db<br/>/data/*.csv")]

    INTERNET --> DOMINUS
    DOMINUS --> VOLUME

    style INTERNET fill:#1a1a2e,stroke:#16213e,color:#eee
    style DOMINUS fill:#0f3460,stroke:#533483,color:#eee
    style VOLUME fill:#2d1b69,stroke:#533483,color:#eee
```

## Kubernetes (DOMINUS Cloud)

```mermaid
flowchart TB
    subgraph External[External]
        USERS["Users<br/>Browser / CLI / API"]
        DNS["Cloud DNS<br/>dominus.app"]
    end

    subgraph Cluster[K8s Cluster]
        INGRESS["Ingress<br/>TLS termination<br/>dominus.app → service"]
        SERVICE["dominus-service<br/>ClusterIP :8080"]
        subgraph Pods[Deployment Pods]
            APP["dominus-app<br/>2+ replicas<br/>Express API + Worker"]
        end
        HPA["HorizontalPodAutoscaler<br/>CPU > 70%"]
    end

    subgraph State[Stateful Backing Services]
        PG[("Managed PostgreSQL<br/>HA / automated backups")]
        REDIS[("Redis<br/>(optional cache)"]
        BLOB[("Object Storage<br/>(backups)"]
    end

    subgraph Monitoring[Observability]
        PROM[Prometheus<br/>/metrics scrape]
        GRAF[Grafana<br/>dashboards]
    end

    DNS --> INGRESS
    USERS --> INGRESS
    INGRESS --> SERVICE
    SERVICE --> APP
    HPA --> APP

    APP --> PG
    APP -.-> REDIS
    APP --> BLOB
    APP --> PROM
    PROM --> GRAF

    style External fill:#1a1a2e,stroke:#16213e,color:#eee
    style Cluster fill:#16213e,stroke:#0f3460,color:#eee
    style Pods fill:#0f3460,stroke:#533483,color:#eee
    style State fill:#2d1b69,stroke:#533483,color:#eee
    style Monitoring fill:#1a1a2e,stroke:#16213e,color:#ddd
```

## Resource Requirements

| Edition | CPU | RAM | Storage | Cost |
|---------|-----|-----|---------|------|
| Community (Docker) | 0.5 core | 256 MB | 1 GB (SQLite + data files) | ~€0 (existing hardware) |
| Cloud (K8s minimal) | 1 core | 1 GB | 10 GB (PostgreSQL + backups) | ~€25-50/mo |

## Port Mapping

| Port | Protocol | Purpose | Community | Cloud |
|------|----------|---------|-----------|-------|
| 8080 | HTTP | REST API + dashboard | ✓ | ✓ |
| 8081 | HTTP | Prometheus metrics | ✓ | ✓ |
