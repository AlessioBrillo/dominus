import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from './types/errors.js';

const configSchema = z.object({
  DATABASE_PATH: z.string().min(1).default('./data/dominus.db'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .preprocess((v) => (typeof v === 'string' ? v === 'true' : Boolean(v)), z.boolean())
    .default(false),
  SCORING_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  SCORING_RECOMMEND_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  DROP_SCORE_THRESHOLD: z.coerce.number().min(0).max(100).default(25),
  DROP_RENEWAL_HORIZON_DAYS: z.coerce.number().int().min(1).default(60),
  /**
   * Optional path to a JSON file produced from Google Keyword Planner export.
   * Format: array of { term, monthlySearchVolume, cpc, competition }.
   * When absent, ManualKeywordProvider returns zero-volume for all terms.
   */
  KEYWORD_DATA_PATH: z.string().optional(),
  /**
   * Keyword provider implementation to use.
   * Supported values: 'manual' (reads from KEYWORD_DATA_PATH JSON file).
   * Adding a new provider (e.g. 'google-keyword-planner') requires:
   *   1. Creating a new implementation of KeywordProvider interface
   *   2. Adding the type to the union below
   *   3. Adding the factory case in src/providers/keyword/index.ts
   */
  KEYWORD_PROVIDER: z.enum(['manual', 'google-ads']).default('manual'),
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
   * Optional path to a CSV file of NameBio comparable sales.
   * Columns: domain,price,date,venue
   * When absent, ManualCompsProvider returns no comparables.
   */
  COMPS_DATA_PATH: z.string().optional(),
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
   * Default points at the production EUIPO CAS endpoint; the operator can
   * switch to the sandbox (`https://auth-sandbox.euipo.europa.eu/oidc/access_token`)
   * by overriding this variable. EUIPO periodically rotates the exact path,
   * so the default is a placeholder until a verified current URL is known.
   */
  EUIPO_AUTH_URL: z.string().url().default('https://euipo.europa.eu/oauth2/token'),
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
   * Default TTL in days for generic provider cache entries (comps, keyword).
   * Each provider may override this individually. Default: 7.
   */
  PROVIDER_CACHE_TTL_DAYS: z.coerce.number().int().min(1).default(7),
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
   * Defaults to 10 to avoid overwhelming the system resolver or triggering
   * rate-limiting by upstream DNS servers.
   */
  DNS_BULK_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * Maximum time (ms) to wait for a WHOIS port-43 response.
   * Increase for slow ccTLD WHOIS servers, decrease to fail fast.
   */
  WHOIS_LOOKUP_TIMEOUT: z.coerce.number().int().min(1000).max(60000).default(10_000),
  /**
   * Rate limiting: max tokens (burst capacity) for RDAP requests.
   * Token bucket refills at RDAP_RATE_LIMIT_TOKENS per RDAP_RATE_LIMIT_INTERVAL_MS.
   * Default: 10 req/sec with burst up to 10.
   */
  RDAP_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(1000).default(10),
  /** Rate limiting: refill interval in ms for RDAP requests (default: 1000). */
  RDAP_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  /**
   * Rate limiting: max tokens (burst capacity) for WHOIS port-43 requests.
   * WHOIS servers are generally more restrictive than RDAP.
   * Default: 1 req/2 sec.
   */
  WHOIS_RATE_LIMIT_TOKENS: z.coerce.number().int().min(1).max(100).default(1),
  /** Rate limiting: refill interval in ms for WHOIS requests (default: 2000). */
  WHOIS_RATE_LIMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(2000),
  /**
   * Absolute cap on suggestedBuyMax in EUR. Prevents the scoring engine
   * from recommending purchases beyond the operator's stated ~500€ budget,
   * even when comparable sales suggest extreme values.
   * Default: 500. Set to 0 for unlimited (not recommended).
   */
  BUY_MAX_ABSOLUTE_CAP: z.coerce.number().min(0).default(500),
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
   * @deprecated No longer used since v0.2.1 — the scoring engine
   * computes confidence via a weight-covered-proportion formula.
   * Kept in the schema for backward compatibility with existing
   * .env files; parsing succeeds but the value is ignored.
   */
  SCORING_CONFIDENCE_PER_SIGNAL: z.coerce.number().min(0).max(1).default(0.3),
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

  /** Hours since last check before a watchlist entry is re-polled. */
  WATCHLIST_POLL_INTERVAL_HOURS: z.coerce.number().int().min(1).default(6),

  /** Delay in ms between RDAP requests during watchlist polling (rate limiting). */
  WATCHLIST_RDAP_DELAY_MS: z.coerce.number().int().min(50).max(5000).default(200),

  /** Maximum concurrent RDAP/WHOIS checks per pipeline stage run. Higher values
   *  speed up batch processing but may trigger rate limits. Default: 5. */
  RDAP_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),

  /** Maximum concurrent trademark gate checks (USPTO/EUIPO) per pipeline stage run.
   *  These are rate-limited APIs so keep this low. Default: 3. */
  TRADEMARK_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),

  /** Maximum concurrent domains to rescore in a single portfolio rescore operation.
   *  Each domain hits scoring engine + trademark gate. Default: 5. */
  RESCORE_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),

  /** HTTP request timeout in milliseconds for Express routes.
   *  Set to 0 to disable. Default: 30000 (30s). */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(0).max(300000).default(30000),

  // ── API hardening config ──────────────────────────────────────────

  /**
   * Allowed CORS origin for the REST API.
   * Set to the URL of your frontend (e.g. http://localhost:5173).
   * Default 'http://localhost:5173' matches the Vite dev server.
   * Set to '*' to allow any origin (use only behind a reverse proxy).
   */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

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
  RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(100),

  // ── Cloudflare Registrar config ───────────────────────────────────

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

  /** Cloudflare API token with Zone:Read, Registrar:Read, Registrar:Write permissions. */
  CLOUDFLARE_API_TOKEN: z.string().optional(),

  /** Cloudflare Account ID (found in the Cloudflare dashboard overview). */
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),

  // ── Registrar / Purchase config ────────────────────────────────────

  /**
   * Active registrar provider name. Set to one of: cloudflare, namecheap,
   * godaddy, porkbun, namesilo, dynadot. Default: manual (no automation).
   * Run `dominus registrars list` to see all available providers.
   */
  REGISTRAR_PROVIDER: z.string().default('manual'),

  /**
   * Auto-approval policy for domain purchases.
   * - 'never' — always require operator confirmation (CLI prompt or API flag)
   * - 'under_buy_max' — auto-approve when price <= suggestedBuyMax
   * - 'always' — auto-approve every purchase (use with caution)
   */
  PURCHASE_AUTO_APPROVAL: z.enum(['never', 'under_buy_max', 'always']).default('never'),

  /** Namecheap API key (REGISTRAR_PROVIDER=namecheap). */
  REGISTRAR_NAMECHEAP_API_KEY: z.string().optional(),
  /** Namecheap account username. */
  REGISTRAR_NAMECHEAP_USERNAME: z.string().optional(),
  /** Namecheap whitelisted client IP. */
  REGISTRAR_NAMECHEAP_CLIENT_IP: z.string().optional(),

  /** GoDaddy API key (REGISTRAR_PROVIDER=godaddy). */
  REGISTRAR_GODADDY_API_KEY: z.string().optional(),
  /** GoDaddy API secret. */
  REGISTRAR_GODADDY_API_SECRET: z.string().optional(),

  /** Porkbun API key (REGISTRAR_PROVIDER=porkbun). */
  REGISTRAR_PORKBUN_API_KEY: z.string().optional(),
  /** Porkbun secret API key. */
  REGISTRAR_PORKBUN_SECRET_API_KEY: z.string().optional(),

  /** NameSilo API key (REGISTRAR_PROVIDER=namesilo). */
  REGISTRAR_NAMESILO_API_KEY: z.string().optional(),

  /** Dynadot API key (REGISTRAR_PROVIDER=dynadot). */
  REGISTRAR_DYNADOT_API_KEY: z.string().optional(),
});

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

  // When AUTO_TUNE_ENABLED is true and no explicit AUTO_TUNE_DRY_RUN was
  // set by the operator, flip dry-run to false so the tuner actually applies
  // weights. The zod default of true means the env var must be set to
  // "false" explicitly, which is non-obvious for a new user enabling tuning.
  if (_config.AUTO_TUNE_ENABLED && process.env.AUTO_TUNE_DRY_RUN === undefined) {
    _config.AUTO_TUNE_DRY_RUN = false;
  }

  return _config;
}

export function resetConfig(): void {
  _config = null;
}
