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
   * Optional path to a CSV file of NameBio comparable sales.
   * Columns: domain,price,date,venue
   * When absent, ManualCompsProvider returns no comparables.
   */
  COMPS_DATA_PATH: z.string().optional(),
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
  /** Confidence increment per additional signal (default: 0.3). */
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

  // ── API hardening config ──────────────────────────────────────────

  /**
   * Allowed CORS origin for the REST API.
   * Set to the URL of your frontend (e.g. http://localhost:5173).
   * Default '*' allows any origin (safe for local-only / reverse-proxy setups).
   */
  CORS_ORIGIN: z.string().default('*'),

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
   */
  API_KEYS: z.string().optional(),

  /** Cloudflare API token with Zone:Read, Registrar:Read, Registrar:Write permissions. */
  CLOUDFLARE_API_TOKEN: z.string().optional(),

  /** Cloudflare Account ID (found in the Cloudflare dashboard overview). */
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
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
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
