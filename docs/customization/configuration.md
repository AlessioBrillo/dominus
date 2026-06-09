# Configuration Reference

Complete list of environment variables for DOMINUS. All variables are read
from the environment (`.env` file or process env).

## Core

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DATABASE_PATH` | `./data/dominus.db` | No | SQLite database file path |
| `PORT` | `3000` | No | HTTP server port |
| `HOST` | `127.0.0.1` | No | Network interface to bind |
| `LOG_LEVEL` | `info` | No | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `LOG_PRETTY` | `false` | No | Pretty-print logs (development) |

## Data Sources

| Variable | Default | Description |
|----------|---------|-------------|
| `KEYWORD_DATA_PATH` | — | Path to Google Keyword Planner JSON export |
| `COMPS_DATA_PATH` | — | Path to NameBio comparable sales CSV |

## Scoring Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `BUY_MAX_ABSOLUTE_CAP` | `500` | Absolute cap on suggestedBuyMax (EUR) |
| `SCORING_RECOMMEND_THRESHOLD` | `0.4` | Minimum weightedScore for recommendation |
| `SCORING_WEIGHTS_OVERRIDE` | — | Path to scoring weights JSON override |
| `TLD_BONUSES_PATH` | — | Path to TLD bonus multipliers JSON |
| `SCORING_IDEAL_LENGTH` | `7` | Ideal SLD length |
| `SCORING_MAX_LENGTH` | `20` | Max SLD length |
| `SCORING_MAX_VOLUME` | `1000000` | Max monthly search volume |
| `SCORING_MAX_CPC` | `50` | Max CPC |
| `SCORING_FLOOR_VALUE` | `500` | Floor market value (EUR) |
| `SCORING_HIGH_VALUE` | `10000` | High market value (EUR) |
| `SCORING_MAX_AGE_YEARS` | `20` | Max domain age |
| `SCORING_MAX_BACKLINKS` | `1000` | Max backlinks |
| `SCORING_MAX_WAYBACK` | `500` | Max Wayback snapshots |
| `SCORING_BUY_MAX_RATIO` | `0.5` | Buy-max ratio |
| `SCORING_LIST_PRICE_MULTIPLIER` | `2.5` | List price multiplier |
| `SCORING_BASE_MARKET_VALUE` | `500` | Base market value (EUR) |
| `SCORING_CONFIDENCE_BASE` | `0.2` | Base confidence (1 signal) |
| `SCORING_CONFIDENCE_PER_SIGNAL` | `0.3` | Confidence per extra signal |
| `SCORING_CONFIDENCE_CAP` | `0.8` | Confidence cap |

## Trademark Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `USPTO_SEARCH_URL` | `https://tmsearch.uspto.gov/tmsearch` | USPTO Elasticsearch endpoint |
| `EUIPO_CLIENT_ID` | — | EUIPO OAuth2 client ID |
| `EUIPO_CLIENT_SECRET` | — | EUIPO OAuth2 client secret |
| `EUIPO_AUTH_URL` | `https://euipo.europa.eu/oauth2/token` | EUIPO token endpoint |
| `EUIPO_API_URL` | `https://api.euipo.europa.eu/trademark-search/trademarks` | EUIPO search API |
| `TM_CACHE_TTL_DAYS` | `7` | Trademark cache TTL |

## Trademark Matching

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADEMARK_MIN_TOKEN_LENGTH_FUZZY` | `4` | Min token length for Levenshtein |
| `TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING` | `3` | Min mark length for substring |
| `TRADEMARK_MAX_LEVENSHTEIN` | `1` | Max edit distance |

## Pipeline

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_KEYWORD_TLD` | `.com` | TLD for bare keywords |
| `DNS_BULK_CONCURRENCY` | `10` | Concurrent DNS checks |
| `WHOIS_LOOKUP_TIMEOUT` | `10000` | WHOIS socket timeout (ms) |

## Portfolio

| Variable | Default | Description |
|----------|---------|-------------|
| `DROP_SCORE_THRESHOLD` | `25` | Drop threshold (0-100) |
| `DROP_RENEWAL_HORIZON_DAYS` | `60` | Renewal horizon for drop eval |

## Notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `RENEWAL_WARNING_DAYS` | `30` | Warning alert days before renewal |
| `RENEWAL_CRITICAL_DAYS` | `7` | Critical alert days before renewal |
| `NOTIFIER_DESKTOP_ENABLED` | `false` | Desktop notifications |
| `NOTIFIER_WEBHOOK_URL` | — | Webhook URL |
| `NOTIFIER_TELEGRAM_BOT_TOKEN` | — | Telegram bot token |
| `NOTIFIER_TELEGRAM_CHAT_ID` | — | Telegram chat ID |

## Scheduler

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_ENABLED` | `false` | Enable in-process cron |
| `SCHEDULER_RENEWAL_CHECK_CRON` | `0 8 * * *` | Renewal check cron |
| `SCHEDULER_RESCORE_CRON` | `0 9 * * 1` | Rescore cron (Monday) |
| `SCHEDULER_PRUNE_CRON` | `0 10 1 * *` | Prune cron (1st of month) |
| `SCHEDULER_WATCHLIST_CRON` | `0 */6 * * *` | Watchlist poll cron |

## Watchlist

| Variable | Default | Description |
|----------|---------|-------------|
| `WATCHLIST_POLL_INTERVAL_HOURS` | `6` | Hours between polls |
| `WATCHLIST_RDAP_DELAY_MS` | `200` | Delay between RDAP requests |

## API

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEYS` | — | Comma-separated API keys for auth |
| `CORS_ORIGIN` | `*` | CORS allowed origin |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15min) | Rate limit window |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `CLOUDFLARE_API_TOKEN` | — | Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | — | Cloudflare account ID |
