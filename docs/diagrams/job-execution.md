# Async Job Execution

```mermaid
flowchart TB
    subgraph Caller[Job Enqueue Callers]
        CLI["CLI Commands<br/>dominus run --async<br/>dominus runs wait <id>"]
        API["REST API<br/>POST /api/v1/runs<br/>POST /api/v1/portfolio/rescore"]
        SCHED[Scheduler<br/>Cron: backup, prune,<br/>watchlist, renewal check]
    end

    subgraph Enqueue[Enqueue Path]
        E["enqueueRun() / enqueueJob()<br/>INSERT INTO job_queue"]
        JQ[("Job Queue<br/>(SQLite / PostgreSQL<br/>job_queue table)")]
    end

    subgraph Worker[Job Worker]
        direction TB
        POLL[Poll Loop<br/>configurable 5s interval<br/>adaptive backoff on SQLITE_BUSY]
        CLAIM["Claim Jobs<br/>UPDATE status = 'running'<br/>WHERE status = 'pending'<br/>LIMIT concurrency"]
        DISPATCH[Handler Dispatch<br/>Map&lt;JobType, JobHandler&gt;]
        ABORT[Abort Controller<br/>per active job<br/>signal-aware handlers]
    end

    subgraph Handlers[Registered Job Handlers]
        PRH[PipelineRunHandler<br/>5-stage pipeline execution]
        PRH2[PortfolioRescoreHandler<br/>rescore all portfolio domains]
        BTH[BacktestBuildHandler<br/>run backtest simulations]
        BKH[BackupHandler<br/>database backup to disk]
        PRN[PruneHandler<br/>expired cache/data cleanup]
        WTH[WatchlistPollHandler<br/>poll watched domains]
        RNW[RenewalCheckHandler<br/>check renewal dates]
        WTT[WeightTuneHandler<br/>ML-free weight tuning]
    end

    subgraph Results[Results & Monitoring]
        STATUS["status: pending → running →<br/>completed | failed | cancelled"]
        DLQ[("Dead Letter Queue<br/>maxRetries exhausted")]
        WAIT["dominus runs wait &lt;id&gt;<br/>poll job_queue for status"]
    end

    subgraph Shutdown[Graceful Shutdown]
        STOP["Worker.stop()<br/>clear poll timer"]
        DRAIN["await active jobs<br/>(max gracefulShutdownTimeoutMs)"]
        FORCE["abort() remaining<br/>Mark jobs as 'cancelled'"]
    end

    CLI --> E
    API --> E
    SCHED --> E
    E --> JQ

    POLL --> CLAIM
    CLAIM --> DISPATCH

    DISPATCH --> PRH
    DISPATCH --> PRH2
    DISPATCH --> BTH
    DISPATCH --> BKH
    DISPATCH --> PRN
    DISPATCH --> WTH
    DISPATCH --> RNW
    DISPATCH --> WTT

    PRH -.-> ABORT
    PRH2 -.-> ABORT
    BTH -.-> ABORT

    JQ -.-> POLL
    PRH --> STATUS
    PRH2 --> STATUS
    BTH --> STATUS
    BKH --> STATUS
    PRN --> STATUS
    WTH --> STATUS
    RNW --> STATUS
    WTT --> STATUS
    STATUS --> DLQ
    STATUS --> WAIT

    STOP --> DRAIN
    DRAIN --> FORCE
    FORCE --> STATUS

    style Caller fill:#1a1a2e,stroke:#16213e,color:#eee
    style Enqueue fill:#16213e,stroke:#0f3460,color:#eee
    style Worker fill:#0f3460,stroke:#533483,color:#eee
    style Handlers fill:#16213e,stroke:#533483,color:#eee
    style Results fill:#2d1b69,stroke:#533483,color:#eee
    style Shutdown fill:#1a1a2e,stroke:#16213e,color:#ddd
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `concurrency` | 2 | Max parallel jobs |
| `pollIntervalMs` | 5000 | Poll interval (adaptive backoff on SQLITE_BUSY) |
| `maxRunningAgeMs` | 300000 (5 min) | Stale job reclamation threshold |
| `gracefulShutdownTimeoutMs` | 30000 (30 s) | Max wait for active jobs on shutdown |

## Job States

```
pending → running → completed
                 → failed (→ pending if retries remain)
                 → cancelled
```

Jobs that exhaust `maxRetries` move to the **dead letter queue** for manual
inspection via the DLQ repository.
