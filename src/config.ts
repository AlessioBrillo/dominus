// SPDX-License-Identifier: AGPL-3.0-only
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './types/errors.js';

const configSchema = z
  .object({
    DATABASE_PATH: z.string().min(1).default('./data/dominus.db'),

    /**
     * PostgreSQL connection string for the cloud edition.
     * When set, the application uses PostgreSQL instead of SQLite.
     * Format: postgresql://user:password@host:5432/dbname
     * The community edition leaves this unset and uses DATABASE_PATH (SQLite).
     */
    DATABASE_URL: z.string().optional(),

    /**
     * SQLite busy timeout in milliseconds (default: 30000 = 30s).
     * Controls how long better-sqlite3 waits for a locked database before
     * throwing SQLITE_BUSY. Increase for bulk pipeline writes concurrent
     * with API reads; decrease to fail fast on contention (ADR-0023).
     */
    DATABASE_BUSY_TIMEOUT: z.coerce.number().int().min(0).max(120000).default(30000),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),
    DROP_SCORE_THRESHOLD: z.coerce.number().min(0).max(100).default(25),
    DROP_RENEWAL_HORIZON_DAYS: z.coerce.number().int().min(1).default(60),
    DEFAULT_RENEWAL_COST_EUR: z.coerce.number().min(0).max(10_000).default(10),
    /**
     * Path to a JSON file with keyword metrics (search volume, CPC, competition).
     * Defaults to the bundled synthetic sample at examples/keywords-sample.json.
     * Format: array of { term, monthlySearchVolume, cpc, competition }.
     * When absent or pointing to a non-existent file, ManualKeywordProvider
     * returns zero-volume for all terms.
     */
    KEYWORD_DATA_PATH: z.string().default('./examples/keywords-sample.json'),
    /**
     * Keyword provider implementation to use.
     * Supported values: 'manual' (reads from KEYWORD_DATA_PATH JSON file).
     * Adding a new provider (e.g. 'google-keyword-planner') requires:
     *   1. Creating a new implementation of KeywordProvider interface
     *   2. Adding the type to the union below
     *   3. Adding the factory case in src/providers/keyword/index.ts
     */
    KEYWORD_PROVIDER: z.enum(['manual', 'google-ads', 'google-suggest']).default('google-suggest'),
    /**
     * Google Ads OAuth2 client ID for the Keyword Planner API.
     * Required when KEYWORD_PROVIDER=google-ads.
     * Create credentials at https://console.cloud.google.com/apis/credentials
     */
    GOOGLE_ADS_CLIENT_ID: z.string().optional(),
    /**
     * Google Ads OAuth2 client secret.
     */
    GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
    /**
     * Google Ads OAuth2 refresh token.
     * Generated via the OAuth2 offline access flow.
     */
    GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
    /**
     * Google Ads developer token.
     * Apply at https://developers.google.com/google-ads/api/docs/first-call/dev-token
     * Approval can take 1-4 weeks.
     */
    GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
    /**
     * Google Ads customer ID (without hyphens).
     * Found in the Google Ads dashboard under Settings > Account > Account ID.
     * Format: 1234567890 (10 digits).
     */
    GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
    /**
     * Path to a CSV file of comparable domain sales.
     * Columns: domain,price,date,venue
     * Defaults to the bundled synthetic sample at examples/comps-sample.csv.
     * When absent or pointing to a non-existent file, ManualCompsProvider
     * returns no comparables.
     */
    COMPS_DATA_PATH: z.string().default('./examples/comps-sample.csv'),
    /**
     * API key for the NameBio API (namebio.com/api).
     * When absent, NameBioProvider returns zero comparable sales (graceful degrade).
     */
    NAMEBIO_API_KEY: z.string().optional(),
    /**
     * Comparable-sales provider implementation to use.
     * Supported values: 'manual' (reads from COMPS_DATA_PATH CSV file),
     *                    'namebio' (uses the NameBio REST API).
     * Adding a new provider requires:
     *   1. Creating a new implementation of CompsProvider interface
     *   2. Adding the type to the union below
     *   3. Adding the factory case in src/providers/comps/index.ts
     */
    COMPS_PROVIDER: z.enum(['manual', 'namebio']).default('manual'),
    /**
     * USPTO public trademark search base URL (no API key required).
     * Default: the official US tmsearch.uspto.gov JSON backend.
     */
    /**
     * USPTO tmsearch Elasticsearch backend endpoint.
     * Accepts POST with an ES-style query body; fields: WM (word mark), ST (status),
     * ON (owner name), SN (serial number), RN (registration number).
     */
    USPTO_SEARCH_URL: z.string().url().default('https://tmsearch.uspto.gov/tmsearch'),
    /**
     * EUIPO OAuth2 credentials (free registration at https://euipo.europa.eu/ohimportal/en/open-data).
     * The same `EUIPO_CLIENT_ID` is reused as the `X-IBM-Client-Id` header on the
     * Trademark Search 1.1.0 API — the OAuth2 client_id and the IBM API gateway
     * client identifier are issued together.
     * When absent, EuipoProvider is treated as unavailable (graceful degrade).
     */
    EUIPO_CLIENT_ID: z.string().optional(),
    EUIPO_CLIENT_SECRET: z.string().optional(),
    /**
     * EUIPO OAuth2 token endpoint for the client_credentials grant.
     * Default: the verified TMview production endpoint. The operator can
     * switch to the sandbox
     * (`https://auth-sandbox.euipo.europa.eu/oidc/access_token`)
     * by overriding this variable. If EUIPO rotates the endpoint in the
     * future, check https://www.tmdn.org/ for the current URL.
     */
    EUIPO_AUTH_URL: z.string().url().default('https://auth.tmdn.org/oidc/access_token'),
    /**
     * EUIPO Trademark Search 1.1.0 endpoint (RSQL-based, `X-IBM-Client-Id` required).
     * The legacy COPLA endpoint (`copla/trademark/data-capture/V1/trademarks`) was
     * retired and silently returns zero hits; see ADR-0014 for the migration context.
     */
    EUIPO_API_URL: z
      .string()
      .url()
      .default('https://api.euipo.europa.eu/trademark-search/trademarks'),
    /**
     * Number of days that a cached trademark result remains valid.
     * Avoids re-hitting rate-limited free APIs on repeat pipeline runs.
     */
    TM_CACHE_TTL_DAYS: z.coerce.number().int().min(1).default(7),
    /**
     * TSDR (Trademark Status & Document Retrieval) fallback URL for the
     * USPTO trademark search. Used when the primary Elasticsearch backend
     * (`USPTO_SEARCH_URL`) is unreachable or WAF-blocked.
     * The TSDR data endpoint returns JSON but has a different response shape
     * from the ES backend. Defaults to the public TSDR search data endpoint.
     */
    USPTO_TSDR_SEARCH_URL: z.string().url().default('https://tsdr.uspto.gov/tsdr/tmsearch/data'),
    /**
     * Rate limiting: max tokens (burst capacity) for USPTO trademark requests.
     * Token bucket refills at USPTO_RATE_LIMIT_TOKENS per USPTO_RATE_LIMIT_INTERVAL_MS.
     * Default: 5 req/sec with burst up to 5.
     */
    USPTO_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).default(5),
    /** Rate limiting: refill interval in ms for USPTO requests (default: 1000). */
    USPTO_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    /**
     * Rate limiting: max tokens (burst capacity) for EUIPO trademark requests.
     * Token bucket refills at EUIPO_RATE_LIMIT_TOKENS per EUIPO_RATE_LIMIT_INTERVAL_MS.
     * Default: 5 req/sec with burst up to 5.
     */
    EUIPO_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).default(5),
    /** Rate limiting: refill interval in ms for EUIPO requests (default: 1000). */
    EUIPO_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    /**
     * Default TTL in days for generic provider cache entries (comps, keyword).
     * Each provider may override this individually. Default: 7.
     */
    PROVIDER_CACHE_TTL_DAYS: z.coerce.number().int().min(1).default(7),
    /**
     * Maximum number of entries in the in-memory provider cache (LRU).
     * Set to 0 to disable in-memory caching (DB-only cache).
     * Default: 1000 entries — enough for typical pipeline runs without
     * consuming significant heap. Each entry is ~few KB (JSON string).
     */
    PROVIDER_MEMORY_CACHE_SIZE: z.coerce.number().int().min(0).max(100000).default(1000),
    /**
     * TTL in seconds for in-memory provider cache entries.
     * After this time, entries are evicted and re-fetched from the DB cache
     * or live provider. Must be shorter than PROVIDER_CACHE_TTL_DAYS.
     * Default: 300 (5 minutes).
     */
    PROVIDER_MEMORY_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(300),
    /**
     * TTL in milliseconds for the public (anonymous) scoring cache.
     * Controls how long a scored domain stays cached before re-scoring.
     * Default: 300000 (5 minutes).
     */
    PUBLIC_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(86400000).default(300000),
    /**
     * Anonymous (public) trademark-gate budget (ADR-0056). When enabled, the
     * public scoring namespace draws from a dedicated trademark-check budget
     * (ANON_TRADEMARK_RATE_LIMIT_TOKENS per
     * ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS) instead of the shared USPTO/EUIPO
     * buckets, so an anonymous valuation spike can never starve pipeline runs
     * of trademark capacity.
     * Fail-open: a valuation that cannot obtain a budget slot within
     * ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS returns an 'unverified' verdict (buy
     * signal stripped) instead of waiting or erroring — quality degrades
     * gracefully while provider cost stays bounded.
     * Default: false (community edition keeps today's behaviour).
     */
    ANON_TRADEMARK_BUDGET_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),
    /** Rate limiting: max burst of anonymous trademark checks per interval. */
    ANON_TRADEMARK_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(100).default(2),
    /** Rate limiting: refill interval in ms for the anonymous trademark budget. */
    ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(1000),
    /** Max wait in ms for an anonymous trademark budget slot before failing
     *  open to 'unverified' (must stay well below the provider deadline). */
    ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(15000).default(1000),
    /**
     * Absolute base URL of the public site (e.g. 'https://dominus.app').
     * Used as the origin for canonical URLs, Open Graph metadata, JSON-LD,
     * the robots.txt Sitemap directive, and the sitemap URLs on the
     * server-rendered public pages. When unset, the request origin
     * (protocol + Host header, honoring TRUST_PROXY_DEPTH) is used, which
     * is correct for self-hosted deployments behind a reverse proxy.
     */
    PUBLIC_APP_URL: z.string().url().optional(),
    /**
     * Optional comma-separated allowlist of hostnames accepted as the origin
     * for the public namespace when PUBLIC_APP_URL is unset (e.g.
     * 'domains.example.com,www.example.com'). Prevents Host-header-derived
     * canonical/OG/sitemap URL poisoning via cacheable public responses.
     * When unset, the request origin is used as before (self-hosted installs
     * behind a single reverse proxy). Set PUBLIC_ALLOWED_HOSTS or
     * PUBLIC_APP_URL for any deployment exposed over the internet.
     */
    PUBLIC_ALLOWED_HOSTS: z.string().optional(),
    /**
     * Optional path to a JSON file with operator-approved weight overrides.
     * When set, the scoring engine reads this file at startup and uses the
     * weights inside it instead of DEFAULT_WEIGHTS. The CLI's
     * `backtest suggest-weights --apply` writes this file; the operator
     * is the only one who can activate it (via .env). Per Principle 5
     * (conservatism), no auto-activation is permitted.
     */
    SCORING_WEIGHTS_OVERRIDE: z.string().optional(),
    /**
     * Maximum number of concurrent DNS resolution requests during bulk checks.
     * Defaults to 200. Lower it (e.g. 10) to avoid overwhelming the system
     * resolver or triggering rate-limiting by upstream DNS servers.
     */
    DNS_BULK_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(200),

    /**
     * Per-domain DNS lookup timeout in milliseconds.
     * Each individual DNS resolution (A, AAAA, CNAME, NS, SOA) has this timeout.
     * Increase for slow resolvers, decrease to fail fast on unresponsive NS.
     * Default: 1500ms (1.5 seconds) — reduced from 3000ms for faster pipeline.
     */
    DNS_LOOKUP_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).optional().default(1500),
    /**
     * DNS lookup strategy for availability checks.
     * - 'doh-primary' (default): Try multi-resolver DNS-over-HTTPS (Cloudflare,
     *   Google, Quad9 in parallel) first, fall back to native Node.js resolver
     *   on timeout or error. Best performance in containerized environments
     *   where the system resolver may be slow or non-authoritative.
     * - 'native': Use Node.js built-in resolver only.
     * - 'native-with-doh-fallback': Use native resolver; on timeout, fall back to
     *   DNS-over-HTTPS (Cloudflare by default) for a second attempt.
     * - 'doh-only': Use DNS-over-HTTPS exclusively (no native fallback).
     *   Use when the system resolver is unreliable or unavailable.
     * DoH fallback improves reliability when the system resolver returns
     * sporadic timeouts, at the cost of one extra HTTPS request per timeout.
     */
    DNS_LOOKUP_STRATEGY: z
      .enum([
        'native',
        'native-with-doh-fallback',
        'doh-only',
        'doh-primary',
        'dot-only',
        'dot-alternate',
        'dot-with-doh-fallback',
        'multi-doh-plus-native',
        'doh-alternate',
      ])
      .default('doh-primary'),
    /**
     * Privacy mode (ADR-0065): when true, NO DNS query leaves the host except
     * to the pinned recursor. The default stack sends every candidate domain
     * name to public resolvers (Cloudflare/Google/Quad9 DoH, AdGuard/Mullvad/
     * NextDNS DoT, OpenDNS/Digital Society DoH, and the system/ISP resolver on
     * native legs) — a commercially sensitive investment signal for an
     * operator watching resolver logs. Privacy mode forces ALL strategies
     * (primary, consensus secondary, tertiary) to 'native', so every leg
     * queries only the DNS_NAMESERVERS pins. It therefore REQUIRES
     * DNS_NAMESERVERS to be set: boot fails loudly otherwise, because "private"
     * with the system resolver would still leak to the ISP. Consensus keeps
     * running only when a SECOND distinct recursor is pinned via
     * DNS_CONSENSUS_NAMESERVERS (native-vs-native independence is decided by
     * the endpoint disjointness check); with a single recursor the gate is
     * honestly vetoed at boot — one resolver cannot be its own second opinion.
     * Default: false for both editions. When enabled, DNS_NAMESERVERS is required
     * and DNS_CONSENSUS_NAMESERVERS is required if DNS_CONSENSUS_ENABLED=true.
     */
    DNS_PRIVACY_MODE: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),
    /**
     * DNS-over-HTTPS endpoint for the 'native-with-doh-fallback' strategy.
     * Uses the Google DNS JSON API format: ?name=<domain>&type=<type>.
     * Default: Cloudflare DNS over HTTPS (privacy-first, no ECS).
     */
    DNS_DOH_ENDPOINT: z.string().url().default('https://cloudflare-dns.com/dns-query'),
    /**
     * Max keep-alive connections per DoH endpoint origin (ADI-0044). DoH
     * requests are routed through a pooled undici Agent instead of the default
     * one-shot global dispatcher: bounded idle connections are reused across
     * queries, so a bulk run no longer opens a fresh TLS/HTTP handshake per
     * request. One Agent pool is shared by all endpoints; each origin receives
     * at most this many concurrent sockets, excess requests queue in undici.
     * Default: 64. Range: 1–1000.
     */
    DNS_DOH_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(1000).default(64),

    /**
     * Comma-separated list of custom DNS resolver IP addresses for the native
     * Node.js resolver. When set, each native resolver group creates a dedicated
     * `dns.Resolver` instance with these servers — NEVER calling the global
     * `dns.setServers()`, which would mutate the resolver for all modules
     * in the process (including HTTP clients like `node-fetch`, `undici`).
     * In containerized environments where the embedded DNS (127.0.0.11) is a
     * throughput bottleneck, setting this to public resolvers like
     * `1.1.1.1,8.8.8.8` can dramatically improve bulk lookup performance.
     * Leave unset to keep the system resolver (default behaviour per group).
     */
    DNS_NAMESERVERS: z.string().optional(),

    /**
     * Use a dedicated `dns.Resolver` instance per resolver group instead of
     * the process-global `dnsPromises.resolve()`. When true (default), native
     * lookups create a fresh `dns.Resolver` per group with `setServers()`
     * scoped to that instance, eliminating any global state mutation risk.
     * Set to false only for backward compatibility if a third-party module
     * intercepts `dns.Resolver` instances.
     * Default: true — the safe default after the `setServers()` global
     * mutation was identified as a security and correctness risk.
     */
    DNS_USE_DEDICATED_RESOLVER: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),

    /**
     * Enable parking page detection for registered domains.
     * When `true`, registered domains whose A records resolve to known parking
     * IP ranges (GoDaddy, Sedo, Dan.com, etc.) are NOT filtered by the DNS
     * prefilter — they pass through with `dnsStatus: 'parked'`, allowing
     * RDAP confirmation and scoring to evaluate whether the domain is
     * available via the aftermarket.
     * Default: false (parked domains are filtered as Registered).
     */
    DNS_PARKING_CHECK_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),
    /**
     * Path to a JSON file containing known parking IP ranges for registrar
     * parking page detection. When absent, the bundled reference list at
     * src/providers/dns/parking-ips.json is used (ADR-0059): enabling
     * DNS_PARKING_CHECK_ENABLED works out of the box. An explicit path that
     * is missing also falls back to the bundled list. Operators with fresher
     * data point this at their own file.
     * Format: array of { name: string, cidr: string[] } objects.
     */
    DNS_PARKING_IPS_PATH: z.string().optional(),

    /**
     * TTL for in-memory DNS result cache in seconds.
     * DNS records for domain availability are relatively stable (hours to days).
     * Default: 300 seconds (5 minutes). Increase to reduce redundant lookups
     * across pipeline batches; decrease to detect recent registrations faster.
     * Set to 0 to disable TTL expiry — entries then live until LRU eviction.
     */
    DNS_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
    /**
     * Maximum number of entries in the in-memory DNS result cache.
     * When the cache exceeds this size, least-recently-used entries are evicted.
     * Default: 10000 — sufficient for most pipeline runs (50k candidates × 20% pass rate).
     * Set to 0 to disable the cache entirely.
     */
    DNS_CACHE_MAX_SIZE: z.coerce.number().int().min(0).max(1000000).default(10000),

    /**
     * Enable persistent DNS cache via the provider_cache database table.
     * When true, DNS lookup results are persisted across process restarts
     * with a TTL of DNS_PERSISTENT_CACHE_TTL_HOURS hours.
     * Default: true — avoids redundant lookups after pipeline restarts.
     * Set to false to use only the in-memory LRU cache.
     */
    DNS_PERSISTENT_CACHE_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * Max queries buffered in the DoT pool queue while all connections are at
     * capacity. New queries past this limit fail fast with an EQUEUEFULL error
     * instead of growing the queue without bound (memory protection during
     * oversized bulk runs). Default: 4096. Set to 0 for an unbounded queue
     * (legacy behaviour).
     */
    DNS_DOT_POOL_MAX_QUEUED: z.coerce.number().int().min(0).max(1000000).default(4096),
    /**
     * TTL for persistent DNS cache entries in hours.
     * Default: 168 (7 days). DNS availability is relatively stable but not
     * immutable — domains can be registered or expire at any time. Lower this
     * to detect recent registrations faster at the cost of more redundant
     * lookups across pipeline restarts.
     * Unknown results are never persisted (transient resolver failures are
     * re-checked live; persistent rows older than 15 minutes are treated as
     * misses).
     */
    DNS_PERSISTENT_CACHE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    /**
     * Persistent-cache Available rows older than this many hours are re-checked
     * live instead of served. Availability is the risky verdict — a false
     * positive produces a wasted buy recommendation — so it must not be frozen
     * for the full DNS_PERSISTENT_CACHE_TTL_HOURS like Registered rows are.
     * Default: 24 (1 day). Lower to detect recent registrations faster at the
     * cost of more re-checks of available domains; the Unknown-row window
     * (15 minutes) is unchanged.
     */
    DNS_PERSISTENT_AVAILABLE_STALE_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    /**
     * Rate limiting: max tokens (burst capacity) for DNS resolution requests.
     * Token bucket refills at DNS_RATE_LIMIT_TOKENS per DNS_RATE_LIMIT_INTERVAL_MS.
     * DNS resolvers are typically permissive but bulk pipelines can still trigger
     * soft rate-limiting by authoritative NS. Default: 20 req/sec with burst up to 20.
     */
    DNS_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).default(20),
    /** Rate limiting: refill interval in ms for DNS resolution requests (default: 1000). */
    DNS_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    /**
     * Per-tenant fair share (Cloud only, ADR-0041): max DNS tokens per tenant
     * per DNS_RATE_LIMIT_INTERVAL_MS, enforced on top of the shared platform
     * bucket when Redis is the rate limiter and PROVIDER_FAIR_SHARE_ENABLED is
     * on. Must be lower than or equal to DNS_RATE_LIMIT_TOKENS. Default: 5
     * req/sec per tenant — with 20 global req/sec, one tenant can at most hold
     * a quarter of the budget, never monopolise it.
     */
    DNS_RATE_LIMIT_PER_TENANT_TOKENS: z.coerce.number().int().min(1).max(1000).default(5),
    /** Per-tenant fair share: refill interval in ms for the DNS tenant window (default: 1000). */
    DNS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(1000),
    /**
     * Custom DNS resolver groups for multi-resolver resolution.
     * When set, overrides DNS_LOOKUP_STRATEGY. Each group contains one or more
     * lookup specs that race in parallel; groups are tried sequentially.
     * Format: JSON array of { name, lookups: [{ type: 'native'|'doh', endpoint? }] }
     * Example: [{"name":"primary","lookups":[{"type":"native"},{"type":"doh","endpoint":"https://dns.google/dns-query"}]}]
     * Default: undefined (uses DNS_LOOKUP_STRATEGY to build groups).
     */
    DNS_RESOLVER_GROUPS: z
      .string()
      .optional()
      .transform((val) => {
        if (val === undefined) return undefined;
        try {
          return JSON.parse(val) as unknown;
        } catch {
          return val;
        }
      })
      .pipe(
        z
          .array(
            z.object({
              name: z
                .string()
                .min(1)
                .describe('Human-readable group label (e.g. "primary", "fallback")'),
              lookups: z
                .array(
                  z.discriminatedUnion('type', [
                    z.object({
                      type: z.literal('native'),
                      nameservers: z
                        .array(
                          z
                            .string()
                            .regex(
                              /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$|^\[?[a-fA-F0-9:]+\]?$/,
                            ),
                        )
                        .optional()
                        .describe('Per-group DNS servers override'),
                    }),
                    z.object({
                      type: z.literal('doh'),
                      endpoint: z.string().url().describe('DoH endpoint URL'),
                      format: z
                        .enum(['json', 'wire'])
                        .optional()
                        .describe(
                          "DoH request format: 'json' (default, Google-style DNS JSON API) " +
                            "or 'wire' (RFC 8484 base64url GET for providers without a JSON API, e.g. Quad9)",
                        ),
                    }),
                    z.object({
                      type: z.literal('dot'),
                      endpoint: z.string().describe('DoT server hostname or IP'),
                      port: z.number().int().min(1).max(65535).optional().default(853),
                      servername: z
                        .string()
                        .optional()
                        .describe('TLS SNI for certificate verification'),
                    }),
                  ]),
                )
                .min(1)
                .describe('At least one lookup spec per group'),
            }),
          )
          .optional(),
      )
      .describe(
        'JSON array of resolver groups. ' +
          'Each group has a name and an array of lookups (native, doh, or dot). ' +
          'DoH lookups accept an optional format ("json" default, RFC 8484 wire for ' +
          'providers without a JSON API). ' +
          'Example: [{"name":"primary","lookups":[{"type":"native"},{"type":"doh","endpoint":"https://dns.google/resolve","format":"json"}]}]',
      ),
    /**
     * Enable 2-of-3 DNS consensus cross-validation. When true, every domain the
     * primary resolver reports as Available is re-queried against a second
     * NodeDnsProvider built with DNS_CONSENSUS_STRATEGY; a disagreement
     * downgrades the result to Unknown instead of trusting a single resolver
     * group (ADR-0002 conservatism).
     * Default: true — the availability verdict is the correctness core of the
     * engine, and the cost is bounded: only the Available subset is re-queried
     * (cached per run), not the whole candidate set. Set to false to halve DNS
     * query volume at the expense of single-resolver verdicts.
     */
    DNS_CONSENSUS_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * Lookup strategy for the secondary DNS consensus provider (see
     * DNS_CONSENSUS_ENABLED). Should differ from DNS_LOOKUP_STRATEGY so the two
     * opinions use disjoint resolvers/transports. Default: 'doh-alternate'
     * (OpenDNS + Digital Society over DNS-over-HTTPS wire format) — genuinely
     * operator-disjoint from the primary default 'doh-primary'
     * (Cloudflare/Google/Quad9). DoH on port 443 is universally allowed in
     * cloud/VPS environments where DoT/853 is often blocked by egress filtering.
     * The 2-of-3 independence check enforces operator-disjointness at runtime.
     */
    DNS_CONSENSUS_STRATEGY: z
      .enum([
        'native',
        'native-with-doh-fallback',
        'doh-only',
        'doh-primary',
        'dot-only',
        'dot-alternate',
        'dot-with-doh-fallback',
        'multi-doh-plus-native',
        'doh-alternate',
      ])
      .default('doh-alternate'),
    /**
     * Fallback lookup strategy for the DNS consensus secondary when the primary
     * strategy resolves to zero endpoints (e.g., DoT/853 blocked by egress
     * filtering). When set and the primary strategy yields no usable resolvers,
     * the consensus provider automatically switches to this fallback strategy
     * and logs a structured warning. Default: 'doh-alternate' — DoH on port 443
     * is universally allowed where DoT/853 may be blocked.
     * Set to empty string to disable fallback (gate will disable if primary fails).
     */
    DNS_CONSENSUS_FALLBACK_STRATEGY: z
      .enum([
        'native',
        'native-with-doh-fallback',
        'doh-only',
        'doh-primary',
        'dot-only',
        'dot-alternate',
        'dot-with-doh-fallback',
        'multi-doh-plus-native',
        'doh-alternate',
        'doh-primary-no-fallback',
        'dot-consensus',
        'doh-tertiary',
        '',
      ])
      .default('doh-alternate'),
    /**
     * Comma-separated private recursor addresses (host or host:port) for the
     * DNS consensus secondary (ADR-0042, C3 of the cloud hardening review).
     * Default DHCP-provided DoT relies on egress TCP/853 to public resolvers,
     * which is not guaranteed on a single-VM deployment. Pointing this at a
     * co-hosted recursive resolver (e.g. Unbound from the docker-compose
     * dns-consensus override, `127.0.0.1:5300` via an SSH tunnel)
     * keeps the 2-of-3 gate independent of public egress. When set, the
     * secondary queries these addresses with plain native DNS, overriding
     * DNS_CONSENSUS_STRATEGY. Example: 127.0.0.1:5300,::1:5300
     */
    DNS_CONSENSUS_NAMESERVERS: z.string().optional(),
    /**
     * Enable an optional THIRD DNS consensus opinion (ADR-0045): when true,
     * domains the secondary cannot answer (error/timeout) are re-queried
     * against a third independent provider built from DNS_TERTIARY_STRATEGY.
     * A tertiary Available confirmation rescues the domain; a tertiary
     * Registered answer vetoes it. Default: true — the tertiary leg provides
     * critical resilience when the secondary (or a pinned recursor) is
     * unreachable. The leg is dropped at startup (with a warning) when its
     * resolver set overlaps the primary or the secondary, exactly like the
     * secondary-vs-primary disjointness rule. The default 'doh-tertiary'
     * strategy (OpenDNS + Digital Society + LibreDNS) provides three operators
     * for 2-of-3 majority vote and three independent breaker circuits.
     */
    DNS_TERTIARY_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * Lookup strategy for the DNS consensus tertiary provider (see
     * DNS_TERTIARY_ENABLED). Default: 'doh-tertiary' — multi-operator DoH
     * group (OpenDNS + Digital Society) providing a genuinely independent
     * third opinion disjoint from primary (CF/Google/Quad9) and consensus
     * (AdGuard/Mullvad/NextDNS). Two operators = majority vote + 2 breakers.
     * Overlapping setups disable the leg with a warning (ADR-0064, ADR-0065).
     */
    DNS_TERTIARY_STRATEGY: z
      .enum([
        'native',
        'native-with-doh-fallback',
        'doh-only',
        'doh-primary',
        'dot-only',
        'dot-alternate',
        'dot-with-doh-fallback',
        'multi-doh-plus-native',
        'doh-alternate',
        'doh-primary-no-fallback',
        'dot-consensus',
        'doh-tertiary',
      ])
      .default('doh-tertiary'),
    /**
     * Comma-separated private recursor addresses (host or host:port) for the
     * DNS consensus tertiary (ADR-0045, ADR-0064). Allows a second pinned independent
     * recursor (e.g. a separate Unbound instance on the same host) to serve
     * as the third opinion. When set, the tertiary queries these addresses
     * with plain native DNS, overriding DNS_TERTIARY_STRATEGY.
     * Example: 192.168.1.2:5300
     */
    DNS_TERTIARY_NAMESERVERS: z.string().optional(),
    /**
     * Rate limiting (ADR-0044/0066): max tokens (burst capacity) for the DNS
     * consensus TERTIARY provider only. The tertiary leg must have its own
     * isolated budget so it cannot be starved by primary or secondary traffic.
     * Default: 10 req/sec (lower than secondary 20, primary 20).
     */
    DNS_TERTIARY_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).optional().default(10),
    /** Rate limiting: refill interval in ms for tertiary DNS requests (default: 1000). */
    DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .optional()
      .default(1000),
    /**
     * Per-tenant fair share (Cloud only, ADR-0041): max tertiary DNS tokens
     * per tenant per DNS_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS, enforced
     * on top of the shared platform tertiary bucket when Redis is the rate
     * limiter and PROVIDER_FAIR_SHARE_ENABLED is on.
     */
    DNS_TERTIARY_RATE_LIMIT_PER_TENANT_TOKENS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .default(3),
    /** Per-tenant fair share: refill interval in ms for the tertiary tenant window (default: 1000). */
    DNS_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .optional()
      .default(1000),
    /**
     * Concurrency ceiling for the tertiary DNS consensus verification phase
     * (ADR-0044/0066). The gate is fail-closed, so its own burst must be bounded
     * independently of the Primary's DNS_BULK_CONCURRENCY and secondary's
     * DNS_CONSENSUS_BULK_CONCURRENCY. Default: 10. Range: 1–500.
     */
    DNS_TERTIARY_BULK_CONCURRENCY: z.coerce.number().int().min(1).max(500).optional().default(10),
    /**
     * How many verification legs must confirm an Available verdict before it
     * passes the consensus gate: 1 = a single confirmation beyond the primary
     * (secondary, or tertiary when the secondary cannot answer), 2 = BOTH the
     * secondary and the tertiary must confirm. Default: 1 — preserves the
     * strict 2-of-3 semantics, where one independent confirmation is the
     * minimum bar the ADR-0002 mandate requires. Setting 2 makes the gate
     * stricter (triple agreement) at the cost of extra DNS queries.
     * Under 2, a tertiary-only Available after a secondary failure is an
     * unverifiable verdict, never a rescue (ADR-0059): the tertiary is still
     * consulted, so its Registered verdict keeps veto power.
     * Accepted values: 1-2.
     */
    DNS_CONSENSUS_REQUIRED_AVAILABLE: z.coerce.number().int().min(1).max(2).default(1),
    /**
     * Fraction of consensus-verified domains that may stay unverifiable before
     * a run is flagged degraded (ADR-0039). When the secondary DNS provider
     * fails to confirm more than this share of primary-Available verdicts, the
     * run completes but is marked degraded because its output rests on a single
     * resolver. Default: 0.5 (half). Range: 0.0–1.0 (0 disables).
     */
    DNS_CONSENSUS_DEGRADED_RATIO: z.coerce.number().min(0).max(1).default(0.5),
    /**
     * Minimum number of consensus-verified domains before a degradation is
     * flagged. Small runs must not tag the pipeline on one bad resolver.
     * Default: 10. Range: 1–1e6.
     */
    DNS_CONSENSUS_DEGRADED_MIN: z.coerce.number().int().min(1).max(1_000_000).default(10),
    /**
     * Rate limiting (ADR-0044): max tokens (burst capacity) for the DNS
     * consensus SECONDARY provider only. The 2-of-3 gate must not draw from
     * the primary DNS bucket: sharing it would let a heavy Primary run starve
     * the exact check that is supposed to fail the run closed, and the two
     * providers' budgets would count against each other. Mirrors the primary
     * default (20 req/sec, burst 20) so consensus adds a bounded, isolated
     * second budget.
     */
    DNS_CONSENSUS_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).default(20),
    /** Rate limiting: refill interval in ms for consensus DNS requests (default: 1000). */
    DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    /**
     * Per-tenant fair share (Cloud only, ADR-0041): max consensus DNS tokens
     * per tenant per DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS, enforced
     * on top of the shared platform consensus bucket when Redis is the rate
     * limiter and PROVIDER_FAIR_SHARE_ENABLED is on. Mirrors the primary
     * default (5 req/sec per tenant).
     */
    DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS: z.coerce.number().int().min(1).max(1000).default(5),
    /** Per-tenant fair share: refill interval in ms for the consensus tenant window (default: 1000). */
    DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(1000),
    /**
     * Concurrency ceiling for the secondary DNS consensus verification phase
     * (ADR-0044). The gate is fail-closed, so its own burst must be bounded
     * independently of the Primary's DNS_BULK_CONCURRENCY (default 200): a
     * verification stampede would otherwise multiply the DNS traffic of every
     * run that is already heavy. Default: 20. Range: 1–500.
     */
    DNS_CONSENSUS_BULK_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(20),
    /**
     * Priority reservation ratio for consensus/tertiary legs (ADR-0067).
     * When the shared DNS rate limiter is used (single-process or Redis-backed
     * with fair share disabled), a heavy primary run can exhaust all tokens
     * and starve the verification legs. This reserves a fraction of the
     * DNS_CONSENSUS_RATE_LIMIT_TOKENS bucket for 'consensus' and 'tertiary'
     * priority acquisitions. The primary leg yields when reserved tokens
     * are needed. Default: 0.3 (30% reserved). Range: 0.0–0.5.
     */
    DNS_CONSENSUS_PRIORITY_RESERVED_RATIO: z.coerce.number().min(0).max(0.5).default(0.3),
    /**
     * Enable runtime disjointness validation for the 2-of-3 consensus gate (ADR-0066).
     * When true (default), live DNS queries are issued through each consensus leg
     * at startup to detect anycast/IP overlap that bootstrap checks cannot catch.
     * Set to false to skip runtime validation (e.g., in tests or environments
     * where egress DNS is restricted). The bootstrap-time disjointness checks
     * (hostname/operator-level) still run.
     */
    DNS_CONSENSUS_RUNTIME_VALIDATION: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * Runtime validation mode for the 2-of-3 DNS consensus gate (ADR-0066).
     * - 'strict': any partial resolution or transient failure vetoes the
     *   consensus gate (ok=false, runtimeDegraded=true). The operator MUST fix
     *   resolver topology or explicitly disable consensus.
     * - 'permissive': fail-open on transient failures, logs warning but keeps
     *   gate enabled. The bootstrap check remains authoritative.
     * Default: 'permissive' for community edition (self-hosted, often behind
     * CGNAT/VPN with restricted egress DNS), 'strict' for cloud edition
     * (managed infrastructure with controlled egress). The default is derived
     * from DATABASE_URL and AUTH_PROVIDER: if DATABASE_URL is set or
     * AUTH_PROVIDER !== 'env', it's cloud mode → 'strict'; otherwise 'permissive'.
     * Operators can always override explicitly via the env var.
     */
    DNS_CONSENSUS_RUNTIME_VALIDATION_MODE: z.enum(['strict', 'permissive']).default(() => {
      const isCloud =
        !!process.env.DATABASE_URL ||
        (process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== 'env');
      return isCloud ? 'strict' : 'permissive';
    }),
    /**
     * Test domain used for DNS consensus bootstrap validation (ADR-0066).
     * Must be a domain that resolves consistently (example.com is reserved per RFC 2606).
     * The validation queries this domain through each consensus leg to detect
     * anycast/IP overlap. Default: example.com.
     */
    DNS_CONSENSUS_TEST_DOMAIN: z.string().min(1).optional().default('example.com'),
    /**
     * Timeout per DNS query during consensus bootstrap validation (ms).
     * Must be shorter than DNS_LOOKUP_TIMEOUT_MS to avoid slowing boot.
     * Default: 2000.
     */
    DNS_CONSENSUS_VALIDATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(10000)
      .optional()
      .default(2000),
    /**
     * Per-endpoint circuit breaker for the DNS layer (ADR-0059). DNS is the
     * last provider without circuit protection: RDAP and WHOIS trip on
     * repeated failures (global + per-server), while a dead DNS resolver
     * burned the full lookup timeout on every query, every run. The breaker
     * opens per resolver endpoint (DoH host, DoT endpoint, native nameserver
     * set) after DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD consecutive failures,
     * skipping further queries for the cooldown. Default: true.
     */
    DNS_CIRCUIT_BREAKER_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * Enable DNSSEC validation on all resolver legs (ADR-0061).
     * When true, queries include EDNS0 DO=1 bit and responses are checked for
     * AD flag and bogus status. Bogus responses are treated as Registered
     * (fail-closed, ADR-0002). When false, DNSSEC validation is skipped.
     * Default: true.
     */
    DNS_DNSSEC_VALIDATION_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * Enable DNSSEC validation on native resolver when using pinned recursors
     * (DNS_NAMESERVERS). In privacy mode (DNS_PRIVACY_MODE=true) or when a
     * private recursor is pinned via DNS_CONSENSUS_NAMESERVERS/
     * DNS_TERTIARY_NAMESERVERS, the native resolver path would otherwise skip
     * DNSSEC validation (Node.js built-in resolver does not validate). This
     * setting enables validation via @relaycorp/dnssec for those paths.
     * Requires DNS_DNSSEC_VALIDATION_ENABLED=true and DNS_NAMESERVERS (or
     * consensus/tertiary nameservers) to be configured.
     * Default: true when DNSSEC validation is enabled and nameservers are pinned.
     */
    DNS_NATIVE_DNSSEC_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * Consecutive resolver failures within the window that open the circuit.
     * Mirrors the RDAP per-server breaker default (ADR-0050). Range: 1-100.
     */
    DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
    /**
     * Rolling window (ms) for the failure count. Default: 60000. Range: 1000-600000.
     */
    DNS_CIRCUIT_BREAKER_WINDOW_MS: z.coerce.number().int().min(1000).max(600000).default(60_000),
    /**
     * Cooldown (ms) the circuit stays open before a half-open probe is allowed.
     * Default: 120000 (2 minutes). Range: 1000-600000.
     */
    DNS_CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(1000).max(600000).default(120_000),
    /**
     * Maximum time (ms) to wait for a WHOIS port-43 response.
     * Reduced from 10s to 5s to fail fast on truly dead servers while still
     * allowing legitimate slow ccTLD responses. The WHOIS rescue budget
     * (RDAP_WHOIS_BUDGET_MS) controls how long we wait for rescue specifically.
     * Must be <= RDAP_WHOIS_BUDGET_MS to avoid race where rescue times out
     * before the WHOIS query completes.
     */
    WHOIS_LOOKUP_TIMEOUT: z.coerce.number().int().min(1000).max(60000).default(5_000),
    /**
     * Rate limiting: max tokens (burst capacity) for RDAP requests.
     * Token bucket refills at RDAP_RATE_LIMIT_TOKENS per RDAP_RATE_LIMIT_INTERVAL_MS.
     * Default: 10 req/sec with burst up to 10.
     */
    RDAP_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).default(10),
    /** Rate limiting: refill interval in ms for RDAP requests (default: 1000). */
    RDAP_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    /**
     * Per-tenant fair share (Cloud only, ADR-0041): max RDAP tokens per tenant
     * per RDAP_RATE_LIMIT_INTERVAL_MS, enforced on top of the shared platform
     * bucket when Redis is the rate limiter and PROVIDER_FAIR_SHARE_ENABLED is
     * on. Must be lower than or equal to RDAP_RATE_LIMIT_TOKENS. Default: 3
     * req/sec per tenant against a 10 req/sec shared budget.
     */
    RDAP_RATE_LIMIT_PER_TENANT_TOKENS: z.coerce.number().int().min(1).max(1000).default(3),
    /** Per-tenant fair share: refill interval in ms for the RDAP tenant window (default: 1000). */
    RDAP_RATE_LIMIT_PER_TENANT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(1000),
    /**
     * Global kill-switch for distributed per-tenant fair share (ADR-0041).
     * When false, every caller shares the single global Redis bucket per
     * provider and per-tenant windows are not created. Only meaningful when
     * the Redis rate limiter is in use (Cloud topology); the community
     * SQLite/local limiter is single-user by design and never enforces it.
     * Default: true.
     */
    PROVIDER_FAIR_SHARE_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * JSON array of RDAP bootstrap server entries for multi-provider failover.
     * When set, the IANA bootstrap resolution is skipped. Each entry is either
     * a plain URL string (treated as universal — authoritative for all TLDs)
     * or an object with an explicit per-TLD scope:
     *   ["https://rdap.org/domain/",
     *    {"url": "https://rdap.verisign.com/com/domain/", "tlds": ["com", "net"]}]
     * Scoped servers never report "available" for out-of-scope TLDs — a 404
     * from a server that is not authoritative for the domain's TLD is Unknown.
     */
    RDAP_BOOTSTRAP_URLS: z
      .string()
      .optional()
      .refine(
        (val) => {
          if (val === undefined) return true;
          try {
            const parsed = JSON.parse(val) as unknown;
            if (!Array.isArray(parsed)) return false;
            return parsed.every((u: unknown) => {
              if (typeof u === 'string') return u.startsWith('http');
              if (typeof u === 'object' && u !== null) {
                const o = u as { url?: unknown; tlds?: unknown };
                return (
                  typeof o.url === 'string' &&
                  o.url.startsWith('http') &&
                  (o.tlds === undefined ||
                    (Array.isArray(o.tlds) && o.tlds.every((t) => typeof t === 'string')))
                );
              }
              return false;
            });
          } catch {
            return false;
          }
        },
        {
          message:
            'Must be a JSON array of RDAP bootstrap URL strings or {url, tlds} objects, ' +
            'e.g. ["https://rdap.org/domain/", ' +
            '{"url": "https://rdap.verisign.com/com/domain/", "tlds": ["com"]}]',
        },
      ),
    /**
     * URL of the IANA RDAP bootstrap registry (RFC 7484) used to resolve the
     * authoritative RDAP server for each TLD. When unset or empty, resolution
     * falls back to rdap.org routing for all TLDs.
     * Example: https://data.iana.org/rdap/dns.json
     */
    RDAP_BOOTSTRAP_URL: z.string().url().or(z.literal('')).optional(),

    /**
     * Exponential backoff base for IANA bootstrap refresh retries (ADR-0058).
     * A failed bootstrap fetch no longer waits a full TTL before retrying:
     * the next attempt is scheduled at `base * 2^(failures-1)`, capped at
     * RDAP_BOOTSTRAP_RETRY_MAX_MS. Default: 300000 (5 minutes). Range: 1000
     * (1s) — 86400000 (24h).
     */
    RDAP_BOOTSTRAP_RETRY_BASE_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(86_400_000)
      .default(300_000),

    /**
     * Upper cap for the IANA bootstrap backoff (ADR-0058): the retry delay
     * never exceeds this value, so a long outage polls at most once per cap.
     * Default: 86400000 (24h). Range: 1000 (1s) — 604800000 (7 days).
     */
    RDAP_BOOTSTRAP_RETRY_MAX_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(604_800_000)
      .default(86_400_000),

    /**
     * Maximum keep-alive connections per RDAP origin for the shared undici
     * Agent pool (ADR-0049). Independent of DNS_DOH_MAX_CONNECTIONS and
     * DNS_DOT_POOL_MAX_QUEUED. Default: 32. Range: 1-512.
     */
    RDAP_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(512).default(32),

    /**
     * Maximum acceptable RDAP response body size in bytes. A hostile or
     * misbehaving registry must not be able to feed the process an unbounded
     * body: the Content-Length header is pre-checked and the streamed read is
     * aborted past the cap (GA hardening). Default: 1048576 (1 MiB).
     * Range: 1024-10485760 (10 MiB).
     */
    RDAP_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(1_048_576),

    /**
     * Enable the RDAP 2-of-2 consensus gate (ADR-0050, ADR-0058): every
     * Available verdict from the primary failover must be independently
     * confirmed by a dedicated second RDAP provider (rdap.org by default,
     * see RDAP_CONSENSUS_ENDPOINT). ON by default: the extra HTTP query per
     * Available is the price of the fail-closed guarantee, mirroring the DNS
     * consensus gate (DNS_CONSENSUS_ENABLED, ADR-0040). Disable explicitly
     * to trade safety for volume.
     */
    RDAP_CONSENSUS_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),

    /**
     * Opt-in WHOIS rescue leg for the RDAP 2-of-2 consensus gate (ADR-0051):
     * when the second RDAP leg cannot answer (error/timeout/Unknown), the
     * candidate's verdict is re-checked through the WHOIS port-43 channel
     * within the same bounded budget as the stage's enrichment race. WHOIS
     * "available" confirms the verdict; WHOIS "registered" vetoes it ("registered
     * wins", ADR-0002); a WHOIS timeout/error stays unverifiable and the
     * candidate is downgraded exactly as without the rescue. Rescue is NEVER
     * consulted on a definitive Registered from the second RDAP leg. Default:
     * true — the rescue leg is now enabled by default because the budget
     * (RDAP_WHOIS_BUDGET_MS=3000) is sufficient for it to work on problematic
     * ccTLDs. The per-TLD override (RDAP_CONSENSUS_RESCUE_WHOIS_TLDS) forces
     * rescue for known unstable ccTLDs (.it, .de, .jp, .br, .cn, .ru, .fr, .uk)
     * regardless of this flag. Set RDAP_CONSENSUS_RESCUE_WHOIS_TLDS=[] to disable.
     */
    RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),

    /**
     * Per-TLD override for WHOIS rescue leg (ADR-0051 extension).
     * For TLDs listed here, WHOIS rescue is FORCE-ENABLED regardless of
     * RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED. This targets ccTLDs with historically
     * unstable RDAP (e.g., .it, .de, .jp, .br) where fail-closed RDAP consensus
     * would produce excessive false negatives.
     * Format: JSON array of TLD strings with leading dot, e.g. '[".it",".de",".jp",".br"]'.
     * Default: known problematic ccTLDs with unstable RDAP.
     */
    RDAP_CONSENSUS_RESCUE_WHOIS_TLDS: z
      .string()
      .transform((val) => {
        if (!val || val.trim() === '') return [];
        try {
          const parsed = JSON.parse(val);
          if (!Array.isArray(parsed)) return [];
          return parsed
            .filter((t): t is string => typeof t === 'string' && t.startsWith('.'))
            .map((t) => t.toLowerCase());
        } catch {
          return [];
        }
      })
      .default(['.it', '.de', '.jp', '.br', '.cn', '.ru', '.fr', '.uk']),

    /**
     * Endpoint of the dedicated second RDAP opinion (ADR-0050 §2, ADR-0058).
     * Defaults to the rdap.org universal router: the primary's per-TLD
     * authoritative servers are resolved from the IANA bootstrap, so the
     * universal router is the only single endpoint that is neutral for every
     * TLD. It is deliberately excluded from the origin-disjointness checks
     * (static and runtime) because it doubles as the default second leg —
     * the checks exist to catch a secondary pinned to a registry origin the
     * primary already queries (e.g. a Verisign server for .com while the
     * primary boots VRS/other failover mix). Your own private RDAP relay is
     * the strongest setup. Must be an https URL when set.
     */
    RDAP_CONSENSUS_ENDPOINT: z
      .string()
      .refine((v) => v === '' || v.startsWith('https://'), {
        message: 'RDAP_CONSENSUS_ENDPOINT must be an https URL or empty (empty = not configured)',
      })
      .default('https://rdap.org/'),

    /**
     * Fraction of consensus-confirmed Available domains that may be unverifiable
     * before the run is flagged degraded (rdap-consensus-unverified, ADR-0039
     * pattern). Default: 0.5 (50%). Range: 0.01-1.
     */
    RDAP_CONSENSUS_DEGRADED_RATIO: z.coerce.number().min(0.01).max(1).default(0.5),

    /**
     * Minimum number of consensus-confirmed Available domains before a
     * degradation is ever considered. Protects small runs. Default: 10.
     */
    RDAP_CONSENSUS_DEGRADED_MIN: z.coerce.number().int().min(1).max(1000).default(10),

    /**
     * Rate limiting: token bucket for the second RDAP consensus leg
     * (ADR-0050). Dedicated budget in its own Redis namespace ('rdap-consensus') —
     * a heavy primary run must never starve the gate meant to fail it closed
     * (ADR-0044). Default: 5 req/sec (lower than the primary 10 req/sec).
     */
    RDAP_CONSENSUS_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).default(5),
    /** Rate limiting: refill interval in ms for RDAP consensus requests (default: 1000). */
    RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(1000),
    /**
     * Per-tenant fair share (Cloud only, ADR-0041): max RDAP consensus tokens
     * per tenant per interval, on top of the shared rdap-consensus bucket.
     * Default: 2 req/sec per tenant.
     */
    RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(2),
    /** Per-tenant fair share: refill interval in ms for the RDAP consensus tenant window (default: 1000). */
    RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(1000),

    /**
     * Concurrency ceiling for the RDAP consensus verification phase
     * (ADR-0050). Bounded independently of RDAP_BATCH_CONCURRENCY so a
     * verification stampede cannot multiply registry traffic. Default: 10.
     * Range: 1-50.
     */
    RDAP_CONSENSUS_BULK_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),

    /**
     * Timeout for a single RDAP consensus query on the second leg (ms).
     * Default: 10000. Range: 1000-30000.
     */
    RDAP_CONSENSUS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),

    /**
     * Enable an optional THIRD RDAP consensus opinion (tertiary leg).
     * When true, domains the second RDAP leg cannot answer (error/timeout/Unknown)
     * are re-queried against a third independent provider built from
     * RDAP_TERTIARY_ENDPOINT. A tertiary Available confirmation rescues the domain;
     * a tertiary Registered answer vetoes it. Default: false — the strict 2-of-2
     * gate already fails closed, so the third leg is only worth its extra query
     * when a genuinely independent resolver is available (e.g. a registry-authoritative
     * endpoint like rdap.verisign.com for .com/.net). The leg is dropped at
     * startup (with a warning) when its endpoint origin overlaps the primary's
     * authoritative origins or the secondary's origin, exactly like the
     * secondary-vs-primary disjointness rule.
     */
    RDAP_CONSENSUS_TERTIARY_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),
    /**
     * Endpoint of the dedicated third RDAP opinion (tertiary leg).
     * Should be an authoritative registry RDAP endpoint (e.g.
     * https://rdap.verisign.com/com/domain/ for .com/.net) to guarantee
     * operator independence from the primary (IANA bootstrap) and secondary
     * (rdap.org). Must be an https URL when set. When empty, the tertiary
     * leg is not configured even if RDAP_CONSENSUS_TERTIARY_ENABLED=true.
     */
    RDAP_TERTIARY_ENDPOINT: z
      .string()
      .refine((v) => v === '' || v.startsWith('https://'), {
        message: 'RDAP_TERTIARY_ENDPOINT must be an https URL or empty (empty = not configured)',
      })
      .default(''),
    /**
     * Rate limiting: token bucket for the third RDAP consensus leg.
     * Dedicated budget in its own Redis namespace ('rdap-consensus-tertiary') —
     * a heavy primary/secondary run must never starve the tertiary leg.
     * Default: 3 req/sec (lower than secondary 5 req/sec).
     */
    RDAP_TERTIARY_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).default(3),
    /** Rate limiting: refill interval in ms for RDAP tertiary requests (default: 1000). */
    RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    /**
     * Per-tenant fair share (Cloud only, ADR-0041): max RDAP tertiary tokens
     * per tenant per interval, on top of the shared rdap-consensus-tertiary bucket.
     * Default: 1 req/sec per tenant.
     */
    RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_TOKENS: z.coerce.number().int().min(1).max(1000).default(1),
    /** Per-tenant fair share: refill interval in ms for the RDAP tertiary tenant window (default: 1000). */
    RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(1000),
    /**
     * Concurrency ceiling for the RDAP tertiary verification phase.
     * Bounded independently of RDAP_CONSENSUS_BULK_CONCURRENCY so a
     * verification stampede cannot multiply registry traffic. Default: 5.
     * Range: 1-50.
     */
    RDAP_TERTIARY_BULK_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    /**
     * Timeout for a single RDAP tertiary query (ms).
     * Default: 10000. Range: 1000-30000.
     */
    RDAP_TERTIARY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),

    /**
     * Rate limiting: max tokens (burst capacity) for WHOIS port-43 requests.
     * WHOIS servers are generally more restrictive than RDAP.
     * Default: 2 tokens — burst allows 2 quick lookups, sustained at 1 req/sec
     * (refill: 2 tokens every 2000ms = 1 token/sec).
     */
    WHOIS_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(100).default(2),
    /** Rate limiting: refill interval in ms for WHOIS requests (default: 2000). */
    WHOIS_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(2000),
    /**
     * Per-tenant fair share (Cloud only, ADR-0041): max WHOIS tokens per tenant
     * per WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS, enforced on top of the shared
     * platform WHOIS bucket when Redis is the rate limiter and
     * PROVIDER_FAIR_SHARE_ENABLED is on (ADR-0052). WHOIS is the most restrictive
     * channel in the stack (default 2 tokens / 2000ms): without an independent
     * tenant window, one tenant's run would starve every other tenant on the
     * shared bucket. Must be lower than or equal to WHOIS_RATE_LIMIT_TOKENS.
     * Default: 1 token per tenant against a 2-token shared budget.
     */
    WHOIS_RATE_LIMIT_PER_TENANT_TOKENS: z.coerce.number().int().min(1).max(100).default(1),
    /** Per-tenant fair share: refill interval in ms for the WHOIS tenant window (default: 2000). */
    WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(2000),
    /**
     * Optional JSON string mapping TLDs to per-registry WHOIS rate limiter configs.
     * Each entry overrides the global WHOIS_RATE_LIMIT_TOKENS/INTERVAL for that TLD.
     * Example:
     *   {"de":{"tokensPerInterval":1,"intervalMs":20000},"com":{"maxTokens":5,"tokensPerInterval":5,"intervalMs":1000}}
     *
     * Validated at startup — invalid JSON or structure causes a ConfigError.
     */
    WHOIS_RATE_LIMIT_OVERRIDES: z
      .string()
      .optional()
      .refine(
        (val) => {
          if (val === undefined) return true;
          try {
            const parsed = JSON.parse(val) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
              return false;
            for (const [tld, cfg] of Object.entries(parsed)) {
              if (typeof tld !== 'string' || !tld.startsWith('.')) return false;
              if (typeof cfg !== 'object' || cfg === null) return false;
              const c = cfg as Record<string, unknown>;
              if (
                typeof c.maxTokens !== 'undefined' &&
                (typeof c.maxTokens !== 'number' || c.maxTokens < 1)
              )
                return false;
              if (
                typeof c.tokensPerInterval !== 'undefined' &&
                (typeof c.tokensPerInterval !== 'number' || c.tokensPerInterval < 1)
              )
                return false;
              if (
                typeof c.intervalMs !== 'undefined' &&
                (typeof c.intervalMs !== 'number' || c.intervalMs < 100)
              )
                return false;
            }
            return true;
          } catch {
            return false;
          }
        },
        {
          message: 'Must be a valid JSON object mapping TLDs (e.g. ".com") to rate limiter configs',
        },
      ),
    /**
     * Absolute cap on suggestedBuyMax in EUR, applied AFTER the evidence
     * anchor and buyMaxRatio. The default 0 means NO cap: expectedValue is
     * anchored to the market signal's median comparable price when market
     * data exists (ADR-0055), so a fixed ceiling would flatten every
     * above-cap domain to the same recommendation. Set a positive value to
     * enforce a hard per-deal budget regardless of evidence.
     * Default: 0 (uncapped).
     */
    BUY_MAX_ABSOLUTE_CAP: z.coerce.number().min(0).default(0),
    /**
     * Number of years of renewal costs to subtract from the raw buy-max.
     * suggestedBuyMax = max(0, expectedValue × buyMaxRatio − renewalCost ×
     * holdingYears). A holding period of 3 means a €12/yr renewal reduces
     * buy-max by €36. Only applies when renewalCost is provided (portfolio
     * rescore). Default: 3.
     */
    SCORING_HOLDING_YEARS: z.coerce.number().int().min(1).max(20).default(3),

    // ── Scoring signal calibration (fork-friendly overrides) ──────────

    /** Ideal SLD length for intrinsic signal (default: 7). */
    SCORING_IDEAL_LENGTH: z.coerce.number().int().min(1).max(50).default(7),
    /** Maximum SLD length for intrinsic signal (default: 20). */
    SCORING_MAX_LENGTH: z.coerce.number().int().min(1).max(100).default(20),
    /** Maximum monthly search volume for commercial signal (default: 1,000,000). */
    SCORING_MAX_VOLUME: z.coerce.number().int().min(1).default(1_000_000),
    /** Maximum CPC for commercial signal (default: 50). */
    SCORING_MAX_CPC: z.coerce.number().min(0.01).default(50),
    /** Floor market value in EUR for market signal (default: 500). */
    SCORING_FLOOR_VALUE: z.coerce.number().min(0).default(500),
    /** High market value in EUR for market signal (default: 10,000). */
    SCORING_HIGH_VALUE: z.coerce.number().min(1).default(10_000),
    /** Maximum domain age in years for expiry signal (default: 20). */
    SCORING_MAX_AGE_YEARS: z.coerce.number().int().min(1).default(20),
    /** Maximum backlinks for expiry signal (default: 1000). */
    SCORING_MAX_BACKLINKS: z.coerce.number().int().min(1).default(1000),
    /** Maximum Wayback snapshots for expiry signal (default: 500). */
    SCORING_MAX_WAYBACK: z.coerce.number().int().min(1).default(500),
    /** Buy-max ratio: suggestedBuyMax = expectedValue * this (default: 0.5). */
    SCORING_BUY_MAX_RATIO: z.coerce.number().min(0).max(1).default(0.5),
    /** List price multiplier: suggestedListPrice = expectedValue * this (default: 2.5). */
    SCORING_LIST_PRICE_MULTIPLIER: z.coerce.number().min(1).default(2.5),
    /** Base market value in EUR for expected value calculation (default: 500). */
    SCORING_BASE_MARKET_VALUE: z.coerce.number().min(1).default(500),
    /** Confidence base for zero-signal fallback (default: 0.2). */
    SCORING_CONFIDENCE_BASE: z.coerce.number().min(0).max(1).default(0.2),
    /**
     * Influence of intrinsic quality score on confidence (default: 0.12).
     * 12% of the confidence range is reserved for intrinsic quality;
     * the remaining 88% is driven by the proportion of signal weight
     * covered by actual data. Set lower to reduce intrinsic bias,
     * higher to penalise short/pronounceable names more heavily.
     */
    SCORING_INTRINSIC_QUALITY_INFLUENCE: z.coerce.number().min(0).max(1).default(0.12),
    /** Absolute cap on confidence score (default: 0.8). */
    SCORING_CONFIDENCE_CAP: z.coerce.number().min(0).max(1).default(0.8),

    /**
     * Optional path to a JSON file mapping TLDs to their multiplier bonuses.
     * Format: { ".com": 1.0, ".io": 0.85, ... }
     * Merged with defaults; unknown TLDs fall back to 0.3.
     */
    TLD_BONUSES_PATH: z.string().optional(),

    /** Default TLD appended to bare keywords in candidate generation (default: .com). */
    DEFAULT_KEYWORD_TLD: z.string().default('.com'),

    // ── Trademark matching calibration ─────────────────────────────────

    /** Minimum token length for Levenshtein fuzzy matching (default: 4). */
    TRADEMARK_MIN_TOKEN_LENGTH_FUZZY: z.coerce.number().int().min(1).default(4),
    /** Minimum mark token length for substring matching (default: 3). */
    TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING: z.coerce.number().int().min(1).default(3),
    /** Maximum Levenshtein distance for fuzzy matching (default: 1). */
    TRADEMARK_MAX_LEVENSHTEIN: z.coerce.number().int().min(0).default(1),
    /**
     * Per-provider deadline for trademark lookups inside the gate, in ms.
     * A hung USPTO/EUIPO call is bounded by this deadline and counts as a
     * provider failure (conservative, ADR-0012: strict-TLD domains become
     * Unverified instead of being cleared on one source alone).
     * Minimum 1000 ms. Default: 15000 ms.
     */
    TRADEMARK_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
    // ── Wayback Machine CDX expiry data enrichment ─────────────────────

    /**
     * Enable Wayback Machine CDX API for automatic expiry data enrichment.
     * When enabled, the pipeline fetches domain age and capture count from
     * the Internet Archive for candidates without closeout metadata.
     * Completely free — no API key required.
     * Default: true.
     */
    WAYBACK_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),
    /**
     * Rate limiting: max tokens (burst capacity) for Wayback CDX requests.
     * Token bucket refills at WAYBACK_RATE_LIMIT_TOKENS per WAYBACK_RATE_LIMIT_INTERVAL_MS.
     * The CDX API has no documented rate limit but 5 req/12s is conservative.
     * Default: 5.
     */
    WAYBACK_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(100).default(5),
    /** Rate limiting: refill interval in ms for CDX requests (default: 12000). */
    WAYBACK_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(12000),
    /**
     * Per-domain timeout in ms for a single CDX API call.
     * Wayback CDX can be slow for domains with millions of captures.
     * Default: 10000ms (10 seconds).
     */
    WAYBACK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    /**
     * Maximum number of concurrent Wayback enrichment lookups during
     * a pipeline stage run. Each lookup is one HTTP request to CDX.
     * Default: 3 (conservative — CDX has no documented rate limit).
     */
    WAYBACK_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
    /**
     * CDX API result limit per page. Higher values mean fewer pagination
     * cycles but larger response payloads. The API silently truncates
     * at 100000; we use 5000 for reasonable response sizes.
     * Default: 5000.
     */
    WAYBACK_CDX_PAGE_SIZE: z.coerce.number().int().min(100).max(100000).default(5000),

    /**
     * Network interface to bind the Express server to.
     * '127.0.0.1' listens on localhost only (safe default).
     * '0.0.0.0' exposes on all interfaces (use behind a reverse proxy).
     */
    HOST: z.string().default('127.0.0.1'),

    /**
     * Base path for the frontend SPA assets relative to process.cwd().
     * Default: './frontend/dist'. Deployments with a custom frontend build
     * path (e.g. Docker with multi-stage build) should set this.
     */
    FRONTEND_DIST_PATH: z.string().default('./frontend/dist'),

    /**
     * URL base path for serving the SPA. When the application is behind a
     * reverse proxy that strips a prefix (e.g. /dominus/), set this so the
     * catch-all route only matches paths starting with the prefix.
     * Empty string means the SPA catch-all matches all non-API paths.
     */
    FRONTEND_BASE_PATH: z.string().default(''),

    // ── Renewal monitoring & notifier config ──────────────────────────

    RENEWAL_WARNING_DAYS: z.coerce.number().int().min(1).default(30),
    RENEWAL_CRITICAL_DAYS: z.coerce.number().int().min(1).default(7),

    /** Enable native desktop notifications via notify-send. */
    NOTIFIER_DESKTOP_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),

    /** Generic webhook URL for alert forwarding (e.g. Slack, Discord). */
    NOTIFIER_WEBHOOK_URL: z.string().url().optional(),

    /** Telegram bot token from @BotFather. Requires NOTIFIER_TELEGRAM_CHAT_ID. */
    NOTIFIER_TELEGRAM_BOT_TOKEN: z.string().optional(),

    /** Telegram chat/group ID to receive alerts. */
    NOTIFIER_TELEGRAM_CHAT_ID: z.string().optional(),

    // ── Scheduler config ──────────────────────────────────────────────

    /** Enable the in-process scheduler when the API server starts. */
    SCHEDULER_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),

    /** Cron expression for daily renewal checks. Default: daily at 08:00. */
    SCHEDULER_RENEWAL_CHECK_CRON: z.string().default('0 8 * * *'),

    /** Cron expression for weekly portfolio rescore. Default: Monday 09:00. */
    SCHEDULER_RESCORE_CRON: z.string().default('0 9 * * 1'),

    /** Cron expression for monthly data pruning. Default: 1st at 10:00. */
    SCHEDULER_PRUNE_CRON: z.string().default('0 10 1 * *'),

    /** Cron expression for watchlist RDAP polling. Default: every 6 hours. */
    SCHEDULER_WATCHLIST_CRON: z.string().default('0 */6 * * *'),

    /**
     * Cron expression for portfolio RDAP/WHOIS healthcheck.
     * Verifies renewal dates and detects registrar changes for portfolio domains.
     * Default: weekly on Sunday at 02:00 (off-peak).
     */
    SCHEDULER_PORTFOLIO_HEALTHCHECK_CRON: z.string().default('0 2 * * 0'),

    // ── Backup config ─────────────────────────────────────────────────

    /**
     * Directory for automatic database backups via VACUUM INTO.
     * Default: ./data/backup. Created automatically if it does not exist.
     */
    BACKUP_DIR: z.string().default('./data/backup'),

    /**
     * Number of days to retain database backups. Backups older than this
     * are pruned automatically by the scheduler's backup job.
     * Default: 30 days. Set to 0 to disable auto-prune.
     */
    BACKUP_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),

    /**
     * Cron expression for automatic database backup.
     * Default: daily at 04:00 (off-peak hours).
     */
    SCHEDULER_BACKUP_CRON: z.string().default('0 4 * * *'),

    // ── Point-in-time recovery config (PostgreSQL only, ADR-0054) ──────

    /**
     * Cron expression for the pitr-health job. Verifies PostgreSQL WAL
     * archiving lag and base-backup freshness and feeds the
     * dominus_pitr_* Prometheus gauges. Registered only when the database
     * is PostgreSQL (no-op on the SQLite community edition).
     * Default: every 15 minutes.
     */
    SCHEDULER_PITR_HEALTH_CRON: z.string().default('*/15 * * * *'),

    /**
     * Maximum acceptable WAL archiving lag in bytes before pitr-health
     * reports degraded. WAL segments are 16MB; the default (64MB) tolerates
     * ~4 unarchived segments — far more than an idle archive_timeout cycle.
     */
    PITR_WAL_LAG_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(64 * 1024 * 1024),

    /**
     * Maximum age in hours of the newest PostgreSQL base backup before
     * pitr-health reports degraded. Default 26h: base backups are expected
     * daily (base-backup cron on the host), 26h still covers a missed fire.
     */
    PITR_BASE_BACKUP_MAX_AGE_HOURS: z.coerce.number().int().positive().default(26),

    /**
     * Warmup delay in milliseconds before the scheduler starts its first job
     * after the HTTP server boots. Allows the database connection, provider
     * caches, and rate-limiters to stabilise before any scheduled task fires.
     * Default: 5000ms (5 seconds). Set to 0 to disable warmup (immediate start).
     */
    SCHEDULER_WARMUP_MS: z.coerce.number().int().min(0).max(300_000).default(5000),

    /** Hours since last check before a watchlist entry is re-polled. */
    WATCHLIST_POLL_INTERVAL_HOURS: z.coerce.number().int().min(1).default(6),

    /** Delay in ms between RDAP requests during watchlist polling (rate limiting). */
    WATCHLIST_RDAP_DELAY_MS: z.coerce.number().int().min(50).max(5000).default(200),

    /**
     * Maximum wall-clock time for a single pipeline run in milliseconds.
     * When exceeded, the orchestrator aborts all in-flight work and the
     * run is recorded with an error. Set to 0 to disable.
     * Default: 3_600_000 (1 hour) — enough for ~5000 domains at 10 RDAP/s.
     */
    PIPELINE_TIMEOUT_MS: z.coerce.number().int().min(0).max(86_400_000).default(3_600_000),

    /**
     * TTL for the pipeline advisory lock in milliseconds.
     * The lock is renewed periodically via heartbeat. A shorter TTL means
     * faster recovery after a crash but more frequent renewals.
     * Default: 120_000 (2 minutes).
     */
    PIPELINE_LOCK_TTL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(600_000)
      .default(120_000)
      .optional(),

    /**
     * Heartbeat interval for pipeline lock renewal in milliseconds.
     * Must be significantly shorter than PIPELINE_LOCK_TTL_MS to ensure
     * the lock is renewed before expiry.
     * Default: 30_000 (30 seconds).
     */
    PIPELINE_LOCK_HEARTBEAT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(30_000)
      .optional(),

    /**
     * Persist per-stage pipeline checkpoints to the database so interrupted
     * runs resume from the last completed stage instead of restarting.
     * Uses the pipeline_checkpoints table (SQLite and PostgreSQL).
     * Default: true.
     */
    PIPELINE_CHECKPOINTS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    /** Maximum concurrent RDAP/WHOIS checks per pipeline stage run. Higher values
     *  speed up batch processing but may trigger rate limits. Default: 10. */
    RDAP_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),

    /** Maximum concurrent trademark gate checks (USPTO/EUIPO) per pipeline stage run.
     *  These are rate-limited APIs so keep this moderate. Default: 5. */
    TRADEMARK_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),

    /** Maximum concurrent WHOIS lookups per pipeline stage run. WHOIS opens a
     *  port-43 connection per domain, so keep this low. Default: 3. */
    WHOIS_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),

    /**
     * Per-query timeout in milliseconds for WHOIS lookups.
     * WHOIS port-43 connections can hang on unresponsive servers; this timeout
     * prevents the pipeline from stalling on a single slow lookup.
     * Default: 10000 (10 seconds).
     */
    WHOIS_PER_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),

    /**
     * Maximum time in milliseconds a WHOIS answer may take before it is
     * discarded. RDAP is authoritative (ADR-0035): a WHOIS disagreement within
     * this budget still blocks conservatively, beyond the budget RDAP decides.
     * This keeps large batches moving even when WHOIS servers are slow.
     * Default: 3000 (3 seconds) — increased from 1s to allow WHOIS rescue to
     * actually work for slow ccTLDs (.it, .de, .jp, .br) which commonly
     * respond in 2-4s. The per-TLD rescue list (RDAP_CONSENSUS_RESCUE_WHOIS_TLDS)
     * is enabled by default for these TLDs.
     * Must be >= WHOIS_LOOKUP_TIMEOUT to avoid race where rescue times out
     * before the WHOIS query completes.
     */
    RDAP_WHOIS_BUDGET_MS: z.coerce.number().int().min(50).max(10000).default(5000),

    /**
     * Staleness window in hours after which a persisted RDAP "Available" row
     * is re-checked live instead of served from the provider cache. Mirrors
     * DNS_PERSISTENT_AVAILABLE_STALE_HOURS: availability is the risky verdict
     * (a false positive is a wasted buy recommendation) so it must not be
     * served blindly for the full PROVIDER_CACHE_TTL_DAYS. "Registered" rows
     * are served for the full TTL — the conservative outcome, and expirations
     * are the exception (ADR-0035).
     * Default: 24.
     */
    RDAP_PERSISTENT_AVAILABLE_STALE_HOURS: z.coerce.number().int().min(1).max(720).default(24),

    /**
     * Per-stage execution budget for the pipeline, scaled by the number of
     * candidates flowing into each stage (ADR-0037).
     * budget = STAGE_TIMEOUT_BASE_MS + candidates * STAGE_TIMEOUT_PER_CANDIDATE_MS,
     * capped at STAGE_TIMEOUT_CAP_MS. When a stage exceeds its budget it is
     * aborted and given STAGE_TIMEOUT_GRACE_MS to harvest partial results,
     * otherwise it degrades empty and the run is marked degraded.
     * Defaults: base 30s, 200ms/candidate, cap 1h, grace 5s.
     */
    STAGE_TIMEOUT_BASE_MS: z.coerce.number().int().min(0).max(86_400_000).default(30_000),
    STAGE_TIMEOUT_PER_CANDIDATE_MS: z.coerce.number().int().min(0).max(600_000).default(200),
    STAGE_TIMEOUT_CAP_MS: z.coerce.number().int().min(0).max(86_400_000).default(3_600_000),
    STAGE_TIMEOUT_GRACE_MS: z.coerce.number().int().min(0).max(300_000).default(5_000),

    /** Maximum concurrent domains to rescore in a single portfolio rescore operation.
     *  Each domain hits scoring engine + trademark gate. Default: 5. */
    RESCORE_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),

    /** Maximum concurrent domains to score in a single ScoringStage batch.
     *  Each candidate triggers keyword + comps provider calls (if available),
     *  so higher concurrency may increase API concurrency pressure.
     *  Default: 10 — Fase 4 (parallel signal computation) halved per-candidate
     *  wall-clock, so we can safely double the batch size. */
    SCORING_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),

    /** HTTP request timeout in milliseconds for Express routes.
     *  Set to 0 to disable. Default: 30000 (30s). */
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(0).max(300000).default(30000),

    // ── API hardening config ──────────────────────────────────────────

    /**
     * Comma-separated list of allowed CORS origins for the REST API.
     * Set to the URL(s) of your frontend (e.g. http://localhost:5173).
     * Default 'http://localhost:5173' matches the Vite dev server.
     * In production with same-origin SPA serving, add your public URL
     * or set to '*' only behind a trusted reverse proxy.
     * Multiple origins: http://localhost:5173,https://dominus.example.com
     */
    CORS_ORIGIN: z.string().default('http://localhost:5173'),

    /**
     * Number of reverse proxy hops to trust for client IP resolution.
     * Behind a single reverse proxy (K8s nginx-ingress, Cloudflare, Traefik),
     * set to 1 so req.ip reflects the client IP from X-Forwarded-For.
     * Without this, rate limiting keys on the proxy IP — all users share a bucket.
     * Default: 0. A direct deployment must never trust X-Forwarded-For:
     * with depth > 0 and no proxy in front, clients can spoof the header and
     * empty every per-IP rate limit (public namespace included).
     */
    TRUST_PROXY_DEPTH: z.coerce.number().int().min(0).max(10).default(0),

    /**
     * Rate limiting: window duration in milliseconds (default: 15 minutes).
     */
    RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),

    /**
     * Rate limiting: max requests per window per IP (default: 100).
     * Set to 0 to disable rate limiting entirely.
     */
    RATE_LIMIT_MAX: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(100)
      .refine((val) => val !== 0 || process.env.NODE_ENV === 'development', {
        message: 'RATE_LIMIT_MAX=0 disables rate limiting. Set NODE_ENV=development to allow this.',
      }),
    /**
     * Public (anonymous) per-IP rate limiting: window duration in milliseconds
     * (default: 60000 = 1 minute).
     */
    PUBLIC_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    /**
     * Public (anonymous) per-IP rate limiting: max requests per window per IP
     * across the /public namespace (default: 30). Unauthenticated traffic is
     * the most exposed surface, so it stays conservative; tune upward only for
     * large self-hosted installs.
     */
    PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    /**
     * Per-domain public rate limiting: window duration in milliseconds
     * (default: 60000 = 1 minute).
     */
    PER_DOMAIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    /**
     * Per-domain public rate limiting: max requests for the same domain per
     * window per IP (default: 5). Guards the expensive valuate call on
     * /public/domain/:domain from domain-scoped scraping.
     */
    PER_DOMAIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    /**
     * Public POST /public/scores rate limiting: window duration in milliseconds
     * (default: 60000 = 1 minute).
     */
    POST_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    /**
     * Public POST /public/scores rate limiting: max score creations per window
     * per IP (default: 10).
     */
    POST_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    /**
     * Public POST /public/scores rate limiting: maximum request body size in
     * bytes (default: 1000). Keeps anonymous submissions tiny and cheap.
     */
    POST_BODY_MAX_BYTES: z.coerce.number().int().positive().default(1000),

    // ── API Authentication ────────────────────────────────────────────

    /**
     * Comma-separated API keys for REST API authentication.
     * Format: `name=key` or just `key` (name defaults to 'default').
     * When empty or unset, authentication is disabled (backward-compatible).
     * Example: API_KEYS=admin=sk-admin-key,ro=sk-readonly
     *
     * WARNING: API keys in environment variables are visible in process
     * listings (/proc/self/environ). For production, prefer FILE_API_KEYS
     * which reads keys from a file with restricted permissions (0600).
     */
    API_KEYS: z.string().optional(),
    /**
     * Path to a file containing API keys (one per line in `name=key` format).
     * When set, this takes precedence over API_KEYS env var.
     * Recommended for production to avoid exposing keys in process env.
     * File should have permissions 0600.
     * Format: name=key (one per line), or just `key` to use 'default' as name.
     */
    FILE_API_KEYS: z.string().optional(),
    /**
     * Optional bearer token protecting the /api/v1/metrics/* router
     * (Prometheus scrape + run-history endpoints). When set, every metrics
     * request must carry `Authorization: Bearer <METRICS_TOKEN>`; requests
     * without it receive 401. Default: unset — metrics stay public (legacy
     * behaviour), relying on the reverse proxy to restrict access. Set this
     * when the API port is reachable externally or Prometheus run history
     * should not be readable from the public interface.
     */
    METRICS_TOKEN: z.string().optional(),

    // ── Auto-weight-tuning config ────────────────────────────────────

    /**
     * Enable automatic weight tuning loop. When true, the AutoWeightTuner
     * runs on schedule and writes tuned weights to AUTO_TUNE_WEIGHTS_PATH.
     * The engine picks up auto-tuned weights automatically when no explicit
     * SCORING_WEIGHTS_OVERRIDE is set. Two-gate policy (ADR-0009) still
     * applies when SCORING_WEIGHTS_OVERRIDE is explicitly configured.
     * Default: false (conservative).
     */
    AUTO_TUNE_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),

    /**
     * Path where the AutoWeightTuner writes the tuned weights JSON file.
     * Only used when AUTO_TUNE_ENABLED=true. The engine loads from this path
     * automatically (no need to set SCORING_WEIGHTS_OVERRIDE).
     * Default: ./data/weights-override.json
     */
    AUTO_TUNE_WEIGHTS_PATH: z.string().default('./data/weights-override.json'),

    /**
     * Minimum number of sold outcomes in the backtest sample before the
     * auto-tuner considers a weight adjustment. Prevents over-fitting on
     * tiny samples. Default: 20.
     */
    AUTO_TUNE_MIN_SAMPLE: z.coerce.number().int().min(5).max(1000).default(20),

    /**
     * Maximum absolute delta per signal weight in a single tuning pass.
     * A signal weight cannot move more than this in one go (±5% default).
     * Prevents runaway weight changes from a single noisy batch. Default: 0.05.
     */
    AUTO_TUNE_MAX_DELTA: z.coerce.number().min(0.01).max(0.2).default(0.05),

    /**
     * Maximum total drift (sum of absolute per-signal deltas from DEFAULT_WEIGHTS)
     * before the auto-tuner refuses to apply. This guardrail prevents the weight
     * vector from drifting into operator-unapproved territory. Default: 0.20.
     */
    AUTO_TUNE_MAX_DRIFT: z.coerce.number().min(0.05).max(0.5).default(0.2),

    /**
     * When true, the auto-tuner runs through the full pipeline (validate, suggest,
     * record) but does NOT write the weight override file. Use for monitoring and
     * preview before enabling live tuning. Default: true (safe default).
     */
    AUTO_TUNE_DRY_RUN: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),

    /**
     * Cron expression for the auto-weight-tuning job in the scheduler.
     * Default: first day of each month at 06:00.
     */
    AUTO_TUNE_CRON: z.string().default('0 6 1 * *'),

    // ── Registrar / Purchase config ────────────────────────────────────

    /**
     * Active registrar provider name. Default: manual (no automation).
     */
    REGISTRAR_PROVIDER: z.string().default('manual'),

    /**
     * Auto-approval policy for domain purchases.
     * - 'never' — always require operator confirmation (CLI prompt or API flag)
     * - 'under_buy_max' — auto-approve when price <= suggestedBuyMax
     * - 'always' — auto-approve every purchase (use with caution)
     */
    PURCHASE_AUTO_APPROVAL: z.enum(['never', 'under_buy_max', 'always']).default('never'),

    // ── Acquisition Funnel config ───────────────────────────────────────

    /**
     * Monthly budget cap for domain acquisition (EUR). The acquisition funnel
     * uses this to prioritise candidates and produce a buy-list that stays
     * within budget. Default: 500 EUR.
     */
    ACQUISITION_BUDGET_EUR: z.coerce.number().min(0).default(500),

    /**
     * Minimum confidence score (0-1) for a candidate to be included in the
     * acquisition funnel. Candidates below this threshold are filtered out
     * regardless of expected value. Default: 0.3.
     */
    ACQUISITION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.3),

    /**
     * Minimum suggestedBuyMax (EUR) for a candidate to be included in the
     * acquisition funnel. Candidates whose buy-max is below this threshold
     * are considered too low-value to pursue. Default: 20 EUR.
     */
    ACQUISITION_MIN_BUY_MAX: z.coerce.number().min(0).default(20),

    /**
     * Maximum number of entries in the acquisition funnel buy-list.
     * Zero means no limit (all passing candidates, budget-bound). Default: 0.
     */
    ACQUISITION_FUNNEL_MAX_ENTRIES: z.coerce.number().int().min(0).default(0),

    // ── Drop verdict / NPV config ──────────────────────────────────────

    /**
     * Drop verdict method: 'threshold' (legacy, score-based) or 'npv'
     * (net-present-value based). When 'npv', the drop verdict engine
     * computes NPV = sum(EV * conf / (1+r)^t) - sum(renewal / (1+r)^t)
     * over the horizon and drops domains with negative NPV.
     * Default: 'threshold' (backward-compatible).
     */
    DROP_METHOD: z.enum(['threshold', 'npv']).default('threshold'),

    /**
     * Annual discount rate for NPV calculation (decimal, e.g. 0.05 = 5%).
     * Used to discount future expected value and renewal costs. Higher
     * values make the engine more conservative (lower NPV). Default: 0.05.
     */
    DROP_NPV_DISCOUNT_RATE: z.coerce.number().min(0).max(1).default(0.05),

    /**
     * Number of years to project forward in NPV calculation.
     * Longer horizons increase the weight of renewal costs vs expected
     * value. Default: 5.
     */
    DROP_NPV_HORIZON_YEARS: z.coerce.number().int().min(1).max(20).default(5),

    /**
     * Optional path to a file containing registrar API keys in `key=value` format.
     * The file config is used as a fallback when the corresponding env var is not set.
     * File keys follow the pattern: `registrar_{provider}_{field}` (lowercase).
     * Example for Namecheap: `registrar_namecheap_api_key=sk-xxx`
     * More secure than env vars (not visible in /proc/self/environ).
     * File should have permissions 0600.
     */
    FILE_REGISTRAR_CONFIG: z.string().optional(),

    // ── Auth provider selection ────────────────────────────────────────

    /**
     * Auth provider implementation to use.
     * - 'env': Use API_KEYS env var / FILE_API_KEYS (community edition, default)
     * - 'auth0': Use Auth0 for JWT-based authentication (DOMINUS Cloud)
     */
    AUTH_PROVIDER: z.enum(['env', 'auth0', 'db']).default('env'),

    /**
     * Auth0 domain (e.g., 'dominus.eu.auth0.com').
     * Required when AUTH_PROVIDER=auth0.
     */
    AUTH0_DOMAIN: z.string().optional(),

    /**
     * Auth0 API audience (e.g., 'https://api.dominus.app').
     * Required when AUTH_PROVIDER=auth0. Must match the audience
     * configured in the Auth0 API definition.
     */
    AUTH0_AUDIENCE: z.string().optional(),

    /**
     * Auth0 JWKS URI for public key discovery.
     * Defaults to https://{AUTH0_DOMAIN}/.well-known/jwks.json.
     * Override only if using a custom JWKS endpoint.
     */
    AUTH0_JWKS_URI: z.string().url().optional(),

    /**
     * Auth0 application (client) ID for the interactive SSO login flow
     * (OIDC Authorization Code + PKCE, ADR-0062). Required together with
     * AUTH0_CLIENT_SECRET and AUTH0_CALLBACK_URL to enable the
     * /api/v1/auth/oidc endpoints. The existing bearer-token validation
     * (AUTH0_DOMAIN/AUDIENCE) works without these.
     */
    AUTH0_CLIENT_ID: z.string().optional(),

    /**
     * Auth0 application client secret. Used for the authorization-code
     * exchange and as the HMAC key (HKDF-derived) for the httpOnly session
     * cookie and the transient PKCE cookie. Never exposed to the frontend.
     */
    AUTH0_CLIENT_SECRET: z.string().optional(),

    /**
     * Absolute callback URL that Auth0 redirects to after the login prompt
     * (e.g. 'https://dominus.app/api/v1/auth/oidc/callback'). Must be
     * registered in the Auth0 application allowed callback URLs.
     */
    AUTH0_CALLBACK_URL: z.string().url().optional(),

    /**
     * Lifetime of the httpOnly session cookie minted after a successful SSO
     * login, in hours. The SPA holds no tokens; the session is revocable by
     * logout (or by rotating AUTH0_CLIENT_SECRET). Default: 8h.
     */
    AUTH0_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),

    // ── Listing / Sales Pipeline config ────────────────────────────────

    /**
     * Listing provider implementation to use for marketplace integration.
     * Supported values:
     *   'manual' — local-only tracking, no external API calls (default)
     *   'dan'    — Dan.com Marketplace API (requires DAN_API_KEY)
     * Adding a new provider requires:
     *   1. Creating a new implementation of ListingProvider interface
     *   2. Adding the type to the union below
     *   3. Adding the factory case in src/providers/listing/index.ts
     */
    LISTING_PROVIDER: z.enum(['manual', 'dan']).default('manual'),

    /**
     * Dan.com API key for marketplace listing management.
     * Required when LISTING_PROVIDER=dan.
     * Obtain from https://dan.com/settings/api
     */
    DAN_API_KEY: z.string().optional(),

    /**
     * Default marketplace for listings when none is specified.
     * Options: dan, afternic, sedo, godaddy, manual.
     * Default: manual (local tracking only).
     */
    LISTING_DEFAULT_MARKETPLACE: z
      .enum(['dan', 'afternic', 'sedo', 'godaddy', 'manual'])
      .default('manual'),

    /**
     * Default multiplier applied to the scoring engine's suggestedListPrice
     * when creating a listing without an explicit price.
     * A value of 1.0 uses the scoring engine price as-is.
     * Default: 1.0
     */
    LISTING_DEFAULT_PRICE_MULTIPLIER: z.coerce.number().min(0.1).max(10).default(1.0),

    // ── Job Queue / Worker config (ADR-0023) ──────────────────────────

    /**
     * Enable the in-process job worker. When true, the worker thread polls the
     * job_queue table and executes handlers for queued jobs. Set WORKER_ENABLED=false
     * to run jobs synchronously (legacy mode, backward-compatible).
     * Default: true (async default execution, ADR-0023 Phase 2).
     */
    WORKER_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(true),

    /**
     * Maximum number of jobs processed concurrently by the worker.
     * Higher values increase throughput but may trigger SQLite write contention.
     * For community edition (SQLite), the safe default is 2.
     * For DOMINUS Cloud (PostgreSQL), increase to 4+.
     * Default: 2 (SQLite-safe conservative).
     */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),

    /**
     * Poll interval in milliseconds for the job queue worker.
     * Lower values reduce latency but increase CPU usage.
     * Default: 1000ms (1 second).
     */
    JOB_QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),

    /**
     * Maximum time a job can stay in 'running' status before being
     * auto-requeued by the worker (stuck-job recovery).
     * Default: 3600000ms (1 hour) — matches PIPELINE_TIMEOUT_MS to prevent
     * long-running pipeline jobs from being prematurely requeued and
     * dead-lettered (see ADR-0023 §4.6).
     */
    JOB_MAX_RUNNING_AGE_MS: z.coerce.number().int().min(10000).max(86400000).default(3600000),

    /**
     * How often the worker refreshes heartbeat_at for its currently running
     * jobs. Must be well below JOB_MAX_RUNNING_AGE_MS so a live job never
     * goes stale between heartbeats and gets falsely reaped.
     * Default: 15000ms (15 seconds).
     */
    JOB_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(15000),

    /**
     * Maximum depth (queued jobs) allowed in the job queue before new
     * enqueue attempts are rejected. Prevents unbounded queue growth
     * when the worker cannot keep up with producers (ADR-0023 §4.7).
     * Set to 0 to disable the limit entirely.
     * Default: 1000
     */
    JOB_QUEUE_MAX_DEPTH: z.coerce.number().int().min(0).max(100000).default(1000),

    // ── Usage Metering / Enforcement ─────────────────────────────────

    /**
     * Enforce plan usage limits on API requests. When enabled, every request
     * to the protected API atomically records one `api_calls` unit against the
     * tenant's monthly plan limit and rejects the request with HTTP 429
     * (USAGE_LIMIT_EXCEEDED) once the limit is exhausted. Free-tier tenants
     * use the limits seeded by migration 0045. When disabled, the middleware
     * is a no-op; clients may still meter usage explicitly via
     * POST /api/v1/usage/record.
     * Default: false (opt-in) for the community edition. Managed identity
     * (AUTH_PROVIDER=db/auth0) forces enforcement ON regardless of this flag
     * — a Cloud deploy must never charge for plans while metering nothing.
     * See isUsageEnforcementActive in src/app/auth-factory.ts.
     */
    USAGE_ENFORCEMENT_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),
    /**
     * Automatically create a free-plan subscription row for a tenant on its
     * first authenticated API request. Without this, usage enforcement
     * (USAGE_ENFORCEMENT_ENABLED) errors on tenants that have no subscription
     * row (e.g. signed up but never completed a Stripe checkout) instead of
     * falling back to the free plan. The managed Cloud sets this true; the
     * community edition defaults to false so the DB is never written on
     * request paths it did not write before.
     * Default: false.
     */
    AUTO_PROVISION_TENANTS: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),

    // ── Redis (DOMINUS Cloud) ──────────────────────────────────────────

    /**
     * Redis connection URL for distributed rate limiting, caching, and locking.
     * Format: redis://:password@host:6379/0
     * When set, the application uses Redis-backed implementations of rate limiters,
     * cache providers, and distributed locks. When unset (community edition),
     * all services fall back to in-memory implementations.
     * See ADR-0033 for the architecture.
     */
    REDIS_URL: z.string().optional(),

    /**
     * When true, REDIS_URL is required at startup and the application refuses
     * to start without it. Automatically enabled when DATABASE_URL is set
     * (cloud mode) — distributed rate limiting and locking are mandatory
     * in multi-process deployments. Can be explicitly overridden to false
     * for single-process cloud deployments (testing, staging).
     * Default: true when DATABASE_URL is set, false otherwise.
     */
    REDIS_REQUIRED: z
      .preprocess((v) => {
        if (v !== undefined) return v === 'true' || v === true;
        return undefined;
      }, z.boolean())
      .optional(),

    /**
     * Enable TLS for Redis connections (required for managed Redis services
     * like Upstash, Redis Cloud, or AWS ElastiCache with in-transit encryption).
     */
    REDIS_TLS_ENABLED: z
      .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
      .default(false),

    /**
     * Key prefix for all Redis keys to namespace multi-service Redis instances.
     * Default: 'dominus:'.
     */
    REDIS_KEY_PREFIX: z.string().default('dominus:'),

    /**
     * Maximum Redis connection retry attempts before permanent fallback.
     * Default: 10 (exponential backoff: 200ms, 400ms, …, ~3.4min total).
     */
    REDIS_MAX_RETRIES: z.coerce.number().int().min(0).max(100).default(10),

    /**
     * Base delay in ms for Redis connection retry exponential backoff.
     * Actual delay = min(REDIS_RETRY_BASE_MS * 2^(attempt-1), 30000).
     * Default: 200ms.
     */
    REDIS_RETRY_BASE_MS: z.coerce.number().int().min(50).max(10000).default(200),

    // ── Billing / Subscription (DOMINUS Cloud) ────────────────────────

    /**
     * Stripe secret key for server-side API calls.
     * When set, billing features are enabled (DOMINUS Cloud).
     * When unset (community edition), the billing API returns
     * a free/community status without Stripe interaction.
     */
    STRIPE_SECRET_KEY: z.string().optional(),

    /**
     * Stripe publishable key for the frontend (Stripe Elements, Checkout).
     * Required when STRIPE_SECRET_KEY is set for client-side payment flows.
     */
    STRIPE_PUBLISHABLE_KEY: z.string().optional(),

    /**
     * Stripe webhook signing secret to verify incoming webhook events.
     * Configure this in your Stripe dashboard webhook settings.
     * Required to process subscription lifecycle events asynchronously.
     */
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    /**
     * Stripe Price ID for the monthly subscription plan (e.g. 'pro').
     * Create the price in Stripe Dashboard > Products.
     */
    STRIPE_PRICE_ID_MONTHLY: z.string().optional(),

    /**
     * Stripe Price ID for the annual subscription plan.
     * Create the price in Stripe Dashboard > Products.
     */
    STRIPE_PRICE_ID_YEARLY: z.string().optional(),

    /**
     * Stripe Price IDs for the pro plan, explicit per-interval.
     * When set, takes precedence over the legacy STRIPE_PRICE_ID_MONTHLY /
     * STRIPE_PRICE_ID_YEARLY aliases. When unset, the legacy aliases are used.
     */
    STRIPE_PRICE_ID_PRO_MONTHLY: z.string().optional(),
    STRIPE_PRICE_ID_PRO_YEARLY: z.string().optional(),

    /**
     * Stripe Price IDs for the team plan (€79/mo, 10 seats, 2,500 candidates
     * scored/month). A pipeline run meters its candidate count (ADR-0038), so
     * run throughput is bounded by the monthly candidate budget — enforcement
     * is per calendar month, not per day.
     * Required to offer team checkout; when unset, team subscriptions are
     * handled outside self-service checkout.
     */
    STRIPE_PRICE_ID_TEAM_MONTHLY: z.string().optional(),
    STRIPE_PRICE_ID_TEAM_YEARLY: z.string().optional(),

    /**
     * Stripe Price IDs for the enterprise plan (custom pricing, dedicated
     * support). Required to offer enterprise checkout; when unset, enterprise
     * subscriptions are handled outside self-service checkout.
     */
    STRIPE_PRICE_ID_ENTERPRISE_MONTHLY: z.string().optional(),
    STRIPE_PRICE_ID_ENTERPRISE_YEARLY: z.string().optional(),

    /**
     * Default subscription plan for new tenants.
     * 'free' — community edition, no Stripe integration required.
     * 'pro' — DOMINUS Cloud with Stripe billing.
     * 'team' — DOMINUS Cloud with team seats and Slack support.
     * 'enterprise' — custom plan with dedicated support.
     */
    SUBSCRIPTION_DEFAULT_PLAN: z.enum(['free', 'pro', 'team', 'enterprise']).optional(),

    // ── Data retention ─────────────────────────────────────────────────

    PUBLIC_SCORES_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    EVENTS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  })
  .refine(
    (data) => {
      // Enforce DNS_NAMESERVERS when DNS_PRIVACY_MODE=true in ALL editions.
      // DNS_CONSENSUS_NAMESERVERS is required when BOTH privacy mode and consensus are enabled.
      if (data.DNS_PRIVACY_MODE === true) {
        if (data.DNS_NAMESERVERS === undefined || data.DNS_NAMESERVERS.trim() === '') {
          return false;
        }
        // If consensus is also enabled, we need a SECOND distinct recursor
        if (data.DNS_CONSENSUS_ENABLED === true) {
          return (
            data.DNS_CONSENSUS_NAMESERVERS !== undefined &&
            data.DNS_CONSENSUS_NAMESERVERS.trim() !== ''
          );
        }
      }
      return true;
    },
    {
      message:
        'DNS_PRIVACY_MODE=true requires DNS_NAMESERVERS to be set (pinned recursor for primary). ' +
        'If DNS_CONSENSUS_ENABLED=true, DNS_CONSENSUS_NAMESERVERS must also be set (second distinct recursor for consensus).',
      path: ['DNS_PRIVACY_MODE'],
    },
  )
  .refine(
    (data) => {
      if (data.RDAP_CONSENSUS_TERTIARY_ENABLED === true) {
        return (
          data.RDAP_TERTIARY_ENDPOINT !== undefined &&
          data.RDAP_TERTIARY_ENDPOINT.trim() !== '' &&
          data.RDAP_TERTIARY_ENDPOINT.startsWith('https://')
        );
      }
      return true;
    },
    {
      message:
        'RDAP_CONSENSUS_TERTIARY_ENABLED=true requires RDAP_TERTIARY_ENDPOINT to be a valid https URL.',
      path: ['RDAP_CONSENSUS_TERTIARY_ENABLED'],
    },
  )
  .refine(
    (data) => {
      // WHOIS lookup timeout must not exceed the WHOIS rescue budget, otherwise
      // the rescue timeout fires before the WHOIS query can complete.
      return data.WHOIS_LOOKUP_TIMEOUT <= data.RDAP_WHOIS_BUDGET_MS;
    },
    {
      message:
        'WHOIS_LOOKUP_TIMEOUT must be <= RDAP_WHOIS_BUDGET_MS to avoid race condition where rescue timeout fires before WHOIS query completes.',
      path: ['WHOIS_LOOKUP_TIMEOUT'],
    },
  );

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config !== null) return _config;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  _config = result.data;

  // Startup validation: warn if configured data file paths do not exist.
  // File-based providers (keyword, comps, weights, TLD bonuses) will fail
  // silently at runtime if the path is missing; catching it early prevents
  // silent scoring degradation.
  const filePaths: { key: string; path: string | undefined }[] = [
    { key: 'KEYWORD_DATA_PATH', path: _config.KEYWORD_DATA_PATH },
    { key: 'COMPS_DATA_PATH', path: _config.COMPS_DATA_PATH },
    { key: 'TLD_BONUSES_PATH', path: _config.TLD_BONUSES_PATH },
    { key: 'SCORING_WEIGHTS_OVERRIDE', path: _config.SCORING_WEIGHTS_OVERRIDE },
    { key: 'AUTO_TUNE_WEIGHTS_PATH', path: _config.AUTO_TUNE_WEIGHTS_PATH },
  ];
  for (const { key, path } of filePaths) {
    if (path !== undefined && !existsSync(path)) {
      console.warn(`[config] ${key}=${path} — file not found, will use defaults`);
    }
  }

  return _config;
}

export function resetConfig(): void {
  _config = null;
}
