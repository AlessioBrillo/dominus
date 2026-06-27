# ADR-0033: Cloud Redis Infrastructure — Distributed Rate Limiting, Job Queue, and Cache

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-26 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0023, ADR-0027, ADR-0021, ADR-0032 |
| **Project** | DOMINUS |

## Context

DOMINUS currently runs everything in a single process: Express API, job worker, scheduler, rate limiters, and provider caches. This architecture is sufficient for the community edition (single-user, SQLite) but presents four scalability and reliability bottlenecks for DOMINUS Cloud:

1. **Rate limiting is in-memory per-process** — `src/api/middleware/auth.ts` uses a `Map<string, { count, resetAt }>` for per-IP rate limiting. In a multi-process deployment (necessary for Cloud availability), each process has its own counter. A user rotating through IPs via round-robin DNS can bypass the rate limit by hitting different processes.

2. **Job queue is database-polling single-worker** — The `JobWorker` in `src/jobs/worker.ts` polls SQLite/PostgreSQL for pending jobs via `SELECT ... WHERE status = 'queued'`. With multiple worker processes, every process races on the same rows. The current adaptive backoff on `SQLITE_BUSY` is a mitigation, not a solution. PostgreSQL's `SKIP LOCKED` helps but polling is still wasteful.

3. **Provider caches are per-process** — `CachedProvider` uses an in-memory LRU cache with a database fallback. Two API server processes will each have their own in-memory cache, doubling memory usage and halving the effective cache hit rate. A domain scored on process A is a cache miss on process B until it reads from the database.

4. **Session state has no shared store** — The community edition has no sessions (stateless API key auth). The Cloud edition (ADR-0032) will have JWT refresh tokens, login sessions, and rate limit counters. These need a shared, fast, distributed store.

Redis solves all four problems with a single dependency: in-memory data structures, pub/sub for cache invalidation, sorted sets for rate limiting sliding windows, and blocking list operations (BRPOPLPUSH) for reliable job queues.

This ADR defines the Redis integration for DOMINUS Cloud only. The community edition retains its existing in-memory approaches — Redis is optional for self-hosters.

## Decision Drivers

1. **Community edition at €0** — The community edition must not require Redis or any external service. All Redis-dependent features must have in-memory or SQLite fallbacks. Redis is a Cloud-only dependency.

2. **Minimal new abstractions** — The existing rate limiter, job queue, and cache abstractions are clean. Redis should implement the same interfaces, not introduce new ones.

3. **Graceful degradation** — If Redis is unavailable, the system must not crash. Rate limiting falls back to in-memory (per-process, weaker but functional), job queue falls back to database polling, cache falls back to memory + DB.

4. **Single Redis instance for launch** — A single Redis instance (or a managed service like Upstash or Redis Cloud) is sufficient for the expected launch scale (hundreds of tenants, thousands of jobs/day). Redis Cluster is a future scaling concern, not a launch requirement.

5. **Connection resilience** — The Redis client must handle reconnection, timeouts, and connection pool exhaustion gracefully. Auto-reconnection with exponential backoff is required.

## Considered Options

### Option A: Redis-Backed Implementations of Existing Interfaces (CHOSEN)

Implement `RedisRateLimiter`, `RedisJobQueue`, and `RedisCacheProvider` that implement the same interfaces as their in-memory counterparts. The composition root selects the implementation based on whether `REDIS_URL` is configured.

**Advantages:**
- Zero changes to existing code that consumes rate limiters, job queues, or caches
- Graceful degradation — if Redis is unavailable, the factory falls back to the in-memory implementation
- Each Redis implementation can be tested independently
- Clear code path: new files in `src/providers/redis/`, no changes to existing files
- Consistent with ADR-0004 (provider abstraction pattern)

**Disadvantages:**
- Three separate Redis implementations to maintain
- The existing job queue schema (PostgreSQL) continues to run in parallel — jobs may be in both systems during migration
- Slightly more code than a monolithic Redis service (but cleaner separation)

**Cost Implications:** ~24h development for all three implementations. Operational: single Redis instance (~€5-15/month managed, €0 self-hosted on the same VPS).

**Risk Assessment:** Low. This is a textbook pattern (backing service abstraction). Each Redis implementation is self-contained. Rollback is setting `REDIS_URL` to empty.

---

### Option B: Monolithic Redis Service Wrapper

Create a single `RedisService` class that exposes `rateLimiter`, `jobQueue`, `cache` sub-services, and inject it everywhere a Redis-backed implementation is needed.

**Advantages:**
- Single Redis connection pool managed in one place
- Shared Redis Lua scripts for atomic multi-operation patterns
- Consistent error handling, reconnection, and monitoring

**Disadvantages:**
- Creates a coupling between rate limiting, job queue, and cache that doesn't exist today
- The `RedisService` would need to grow with every new Redis use case
- Harder to test in isolation — testing the rate limiter requires the full `RedisService`
- Deviates from ADR-0004 (each concern has its own interface)

**Cost Implications:** ~16h development (less than Option A). Same operational cost.

**Risk Assessment:** Low-medium. The monolithic wrapper is convenient but creates an anti-pattern where unrelated concerns share a single class. If one sub-service has a bug, the entire connection pool is affected.

---

### Option C: BullMQ for Job Queue + ioredis for Everything Else

BullMQ is a production-grade Redis-backed job queue for Node.js with scheduling, delays, rate limiting, and observability built in. Rate limiting and caching remain custom implementations using ioredis directly.

**Advantages:**
- BullMQ is battle-tested (used by thousands of production applications)
- Built-in features: job scheduling, delays, repeatable jobs, rate limiting per queue, job lifecycle events
- Observability: BullMQ Board (admin UI for queues) and built-in metrics
- Automatic retries with exponential backoff (replaces the custom retry logic in `retry-utils.ts`)
- Graceful worker shutdown via `worker.close()` (replaces the custom AbortController pattern)

**Disadvantages:**
- Opinionated job lifecycle — DOMINUS's `job_queue` schema (5 statuses, `dead_letter_jobs` table) would need to be adapted to BullMQ's model (waiting/active/completed/failed/delayed)
- Migration effort: the existing `JobQueueService` facade and `JobQueueRepository` would need significant changes to work with BullMQ
- Job handlers (`PipelineRunHandler`, etc.) currently receive `(payload, signal)` — BullMQ uses a different job object format
- BullMQ adds ~500KB to the bundle (it's a substantial library)
- The existing PostgreSQL-backed job queue for the community edition must be preserved — BullMQ is Cloud-only

**Cost Implications:** ~32h development (higher due to BullMQ integration complexity). Same Redis operational cost. BullMQ is MIT-licensed (free).

**Risk Assessment:** Medium. BullMQ is excellent but its job model differs significantly from DOMINUS's current approach. The migration cost is substantial for a solo-founder project. The simpler polling-based approach (Option A) can be upgraded to BullMQ later if the queue volume justifies it.

---

### Option D: Upstash (Serverless Redis)

Upstash provides a serverless Redis API via HTTP (no persistent TCP connection). The client library (`@upstash/redis`) works in serverless environments and supports REST API calls.

**Advantages:**
- No persistent TCP connection — works in serverless and edge environments
- HTTP-based — no connection pool management, no reconnection logic
- Free tier: 10,000 requests/day, 256MB storage — covers the launch phase
- Built-in TLS encryption
- Global replication available on paid tiers

**Disadvantages:**
- HTTP latency (~5-10ms per operation) is higher than ioredis (~0.5-1ms over TCP)
- Rate limiting via HTTP is wasteful — every window check is a round trip
- Job queue with BRPOPLPUSH requires persistent connections — Upstash's HTTP model doesn't support blocking operations
- Locking patterns (for job queue) require Lua scripts or WATCH — both are paid Upstash features
- Vendor lock-in to Upstash — the `@upstash/redis` API differs from ioredis

**Cost Implications:** Free tier for launch. Paid tier starts at ~$0.15/GB/month + $0.50/100k requests.

**Risk Assessment:** Medium-High. Upstash is excellent for simple caching and KV storage but is not a full Redis replacement for job queues (blocking operations, Lua scripts). Using Upstash for caching + ioredis for job queues creates two Redis stacks to maintain. For DOMINUS Cloud's architecture (long-running server processes, not serverless), a standard Redis instance (ioredis) is the correct choice.

---

## Decision

**Chosen option: Option A — Redis-Backed Implementations of Existing Interfaces**

The rationale:

1. **Interface-level compatibility is the key constraint.** The existing `RateLimiter`, `JobQueueService`, and `CachedProvider` abstractions are clean and tested. Redis-backed implementations implement the same interfaces. The composition root selects the implementation based on configuration. Code that consumes these services is completely unaware of Redis.

2. **Graceful degradation protects community edition.** If `REDIS_URL` is unset, the factory creates in-memory implementations (as today). If Redis is configured but unreachable, each implementation logs a warning and falls back to its in-memory counterpart. The system degrades, not crashes.

3. **Rejecting BullMQ (Option C):** The integration cost (mapping BullMQ's job model onto DOMINUS's existing job lifecycle, preserving the PostgreSQL-backed path for CE) is too high for the current phase. The existing database-backed queue with Redis-backed enhancements (faster polling, BRPOPLPUSH) achieves 80% of the benefit at 30% of the cost.

4. **Rejecting monolithic wrapper (Option B):** ADR-0004 (provider abstraction) is a core DOMINUS pattern. Each Redis concern implements the same interface as its in-memory counterpart. A combined `RedisService` class would be a step backward in separation of concerns.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Composition Root                                            │
│  - Checks REDIS_URL config                                   │
│  - Routes to Redis or InMemory implementations               │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
┌─────────────────┐ ┌──────────┐ ┌──────────────────┐
│ RedisRateLimiter │ │ RedisJob │ │ RedisCacheProvider│
│ (sliding window  │ │ Queue    │ │ (LRU + TTL +     │
│  via sorted set) │ │ (BRPOPLP │ │  pub/sub invalid)│
└────────┬─────────┘ │ SH)      │ └────────┬─────────┘
         │          └────┬─────┘          │
         │               │                │
         └───────────────┼────────────────┘
                         ▼
                 ┌──────────────┐
                 │  Redis       │
                 │  (ioredis)   │
                 │  7-alpine    │
                 │  AOF persist │
                 └──────────────┘
```

### Implementation Details

#### RedisRateLimiter (`src/providers/redis/redis-rate-limiter.ts`)

| Feature | Implementation |
|---------|---------------|
| Algorithm | Sliding window via Redis sorted sets (ZADD + ZREMRANGEBYSCORE + ZCOUNT) |
| Key format | `ratelimit:{namespace}:{key}` (namespace = `auth`, `api`, `public`) |
| Cleanup | Periodic `ZREMRANGEBYSCORE` via a background timer (every 60s) |
| Fallback | In-memory `Map`-based limiter if Redis is unreachable |
| Atomicity | Single pipeline (ZADD, ZREMRANGEBYSCORE, ZCOUNT, EXPIRE) |

#### RedisJobQueue (`src/providers/redis/redis-job-queue.ts`)

| Feature | Implementation |
|---------|---------------|
| Enqueue | `LPUSH job:{type}:queue <payload>` |
| Dequeue | `BRPOPLPUSH job:{type}:queue job:{type}:processing TIMEOUT 5` |
| Complete | `LREM job:{type}:processing 1 <payload>` |
| Fail | `LPUSH job:{type}:retry <payload>` (up to max_attempts, then `dead_letter`) |
| Fallback | PostgreSQL `job_queue` table polling if Redis is unreachable |

#### RedisCacheProvider (`src/providers/redis/redis-cache-provider.ts`)

| Feature | Implementation |
|---------|---------------|
| Storage | Redis `SETEX` with configurable TTL per provider namespace |
| Invalidation | Redis `DEL` key — cross-process invalidation via shared key namespace |
| Fallback | In-memory LRU cache (same as today's `CachedProvider`) |
| Key format | `cache:{provider}:{key}` |

### Redis Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | (empty) | `redis://:password@host:6379/0` — empty = Redis disabled |
| `REDIS_TLS_ENABLED` | `false` | Enable TLS for managed Redis (Upstash, Redis Cloud) |
| `REDIS_MAX_RETRIES` | `10` | Connection retry attempts before fallback |
| `REDIS_RETRY_BASE_MS` | `200` | Exponential backoff base (doubles each retry) |
| `REDIS_KEY_PREFIX` | `dominus:` | Namespace prefix for multi-service Redis instances |

### Docker Compose (Cloud)

```yaml
redis:
  image: redis:7-alpine
  command: redis-server --appendonly yes --appendfsync everysec
  volumes:
    - redis-data:/data
  ports:
    - "6379:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 3s
    retries: 5
```

## Consequences

### Positive
- Distributed rate limiting works across multiple API server processes
- Job queue supports multiple workers without contention (BRPOPLPUSH guarantees single-consumer)
- Provider caches are shared across processes — higher hit rate, lower database load
- Session state (Cloud auth) has a fast, shared store
- Community edition is completely unaffected — no Redis dependency, no new config
- Graceful degradation in all three Redis-backed services — no crash if Redis is down
- Three independent implementations follow ADR-0004 (provider abstraction)

### Negative
- Three Redis implementations to maintain alongside three in-memory implementations
- Operational complexity: Redis instance must be monitored (memory, hit rate, connected clients, replication lag)
- Memory planning: Redis should be allocated sufficient `maxmemory` for the cache workload (estimate: ~100MB for 10,000 cached domain scores + rate limiter state + job queue backlog)
- AOF persistence adds ~10-20% latency overhead (acceptable for non-critical path operations)
- The existing PostgreSQL-backed job queue continues to exist for community edition — two job queue implementations to maintain

### Compliance and Security Implications
- Redis must not store tenant data permanently — cache TTLs prevent data persistence beyond the configured window
- Redis connections use TLS when `REDIS_TLS_ENABLED=true` (enforce for managed Redis)
- Redis authentication via `REDIS_URL` password (AUTH command) — the Redis instance must have `requirepass` configured
- No PII or sensitive data is stored in Redis (rate limiter keys are IPs, cache values are domain scores, job queue payloads are run IDs)
- Redis ACLs can restrict the application user to specific key patterns if multi-tenant isolation requires it

### Migration and Monitoring Plan
1. Implement `RedisRateLimiter` with sliding window sorted sets, in-memory fallback, and graceful degradation
2. Implement `RedisJobQueue` with BRPOPLPUSH, retry queue, and dead letter list
3. Implement `RedisCacheProvider` with per-namespace TTL and cross-process invalidation
4. Wire factory selection in `src/app/provider-factory.ts` based on `REDIS_URL`
5. Add Redis to `docker-compose.prod.yml`
6. Deploy to staging with Redis, monitor: cache hit ratio, rate limiter latency (p99 < 5ms), job queue throughput
7. Rollback: unset `REDIS_URL` — all services fall back to in-memory/PostgreSQL implementations

### Validation
- Integration tests verify that `RedisRateLimiter` blocks requests exceeding the threshold (p99 latency < 5ms for window check)
- Integration tests verify that `RedisJobQueue` delivers each job to exactly one consumer (no duplicate processing)
- Integration tests verify that `RedisCacheProvider` returns cached values within TTL and fetches fresh values after expiry
- Integration tests verify that all three services fall back to in-memory implementations when Redis is unreachable
- Stress test: 100 concurrent rate limiter checks, 1000 concurrent job enqueues, 10,000 concurrent cache operations

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
