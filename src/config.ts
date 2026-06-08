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

  // ── API hardening config ──────────────────────────────────────────

  /**
   * Allowed CORS origin for the REST API.
   * Set to the URL of your frontend (e.g. http://localhost:5173).
   * Default '*' allows any origin (safe for local-only / reverse-proxy setups).
   */
  CORS_ORIGIN: z.string().default('*'),

  // ── Cloudflare Registrar config ───────────────────────────────────

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
