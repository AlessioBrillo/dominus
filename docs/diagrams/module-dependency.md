# Module Dependencies

High-level dependency graph for the `src/` module structure. Arrows point from
consumer to consumed module.

```mermaid
flowchart LR
    subgraph Entry[Entry Points]
        INDEX["src/index.ts<br/>Express server bootstrap"]
        CLI["src/cli/index.ts<br/>Commander 18 commands"]
    end

    subgraph App[Application Layer]
        CR["composition-root.ts<br/>DI wiring, provider setup"]
        PS["provider-status.ts<br/>health reporting"]
        MW["middleware/<br/>auth, error, security,<br/>rate-limit, request-log"]
    end

    subgraph Core[Core Business Logic]
        PIP["pipeline/<br/>5-stage orchestrator"]
        SC["scoring/<br/>Engine + 4 signals + weights"]
        TM["trademark/<br/>USPTO + EUIPO gate"]
        PORT["portfolio/<br/>Manager + reports + drop logic"]
        SV["services/<br/>auto-listing, etc."]
    end

    subgraph Jobs[Async Job System]
        JW["jobs/worker.ts<br/>Poll + dispatch"]
        JH["jobs/handlers/<br/>8 handlers"]
    end

    subgraph API[REST API]
        API["api/router.ts<br/>Express Router"]
        ROUTES["api/routes/<br/>18 route modules"]
        PUB["api/public-router.ts<br/>Public scoring pages<br/>SSR + OG tags"]
        VIEWS["api/views/<br/>SSR HTML templates"]
    end

    subgraph DB[Database Layer]
        DBI["db/provider/<br/>DatabaseProvider interface"]
        SQLITE["db/adapter/sqlite-adapter.ts"]
        PG["db/adapter/pg-adapter.ts"]
        REPO["db/repositories/<br/>18 repositories"]
        MIG["db/migrations/<br/>versioned DDL"]
    end

    subgraph Providers[External Providers]
        PROV["providers/<br/>dns, rdap, whois<br/>keyword, comps, trademark<br/>registrar, listing"]
    end

    subgraph Types[Shared Types]
        TYPES["types/"]
    end

    subgraph Utils[Utilities]
        UTIL["utils/"]
        LOG["logger.ts"]
        CFG["config.ts"]
    end

    INDEX --> CR
    INDEX --> API
    CLI --> CR

    CR --> PIP
    CR --> SC
    CR --> TM
    CR --> PORT
    CR --> SV
    CR --> JW
    CR --> PROV
    CR --> DBI
    CR --> MW
    CR --> CFG

    API --> ROUTES
    API --> PUB
    API --> MW
    ROUTES --> CR
    PUB --> VIEWS
    PUB --> SC

    JW --> JH
    JH --> PIP
    JH --> SC
    JH --> PORT
    JH --> DBI
    JH --> PROV

    PIP --> TM
    PIP --> SC
    PIP --> PROV
    PIP --> DBI

    SC --> PROV
    SC --> UTIL

    PORT --> DBI
    SV --> DBI
    SV --> PROV

    ROUTES --> TYPES
    PIP --> TYPES
    SC --> TYPES
    PROV --> TYPES
    DBI --> TYPES
    MW --> TYPES

    DBI --> SQLITE
    DBI --> PG
    REPO --> DBI
    MIG --> SQLITE
    MIG --> PG

    style Entry fill:#1a1a2e,stroke:#16213e,color:#eee
    style App fill:#16213e,stroke:#0f3460,color:#eee
    style Core fill:#0f3460,stroke:#533483,color:#eee
    style Jobs fill:#16213e,stroke:#533483,color:#eee
    style API fill:#0f3460,stroke:#16213e,color:#eee
    style DB fill:#2d1b69,stroke:#533483,color:#eee
    style Providers fill:#1a1a2e,stroke:#16213e,color:#ddd
    style Types fill:#2d1b69,stroke:#533483,color:#eee
    style Utils fill:#1a1a2e,stroke:#16213e,color:#ddd
```

## Layer Rules

| Layer | Can Depend On | Cannot Depend On |
|-------|---------------|------------------|
| Core logic (`pipeline/`, `scoring/`, `trademark/`, `portfolio/`) | `types/`, `utils/`, `providers/` (via interfaces) | `api/`, `cli/`, `jobs/` |
| Providers (`providers/`) | `types/`, `utils/` | Core logic, `api/`, `cli/` |
| API (`api/`) | Core logic, `providers/`, `types/` | `cli/` |
| Jobs (`jobs/`) | Core logic, `providers/`, `types/` | `api/`, `cli/` |
| CLI (`cli/`) | Core logic, `types/` | `api/` |
| Database (`db/`) | `types/` | Core logic, `api/`, `cli/`, `providers/` |
