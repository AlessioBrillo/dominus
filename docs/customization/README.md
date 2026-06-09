# Customization Guide

DOMINUS is designed to be forked and customized. This guide explains how to
adapt every layer to your needs — from scoring weights to provider swaps.

## Table of Contents

1. [Scoring Engine](#scoring-engine)
2. [Providers](#providers)
3. [Trademark Matching](#trademark-matching)
4. [Pipeline Behaviour](#pipeline-behaviour)
5. [Notifications](#notifications)
6. [Deployment](#deployment)

---

## Scoring Engine

### Weights

The four signal weights (intrinsic, commercial, market, expiry) can be tuned
via a JSON override file. The default weights are:

| Signal | Default Weight |
|--------|---------------|
| Intrinsic | 0.30 |
| Commercial | 0.35 |
| Market | 0.25 |
| Expiry | 0.10 |

To override, create a JSON file:

```json
{
  "weights": {
    "intrinsic": 0.25,
    "commercial": 0.40,
    "market": 0.25,
    "expiry": 0.10
  }
}
```

Activate it in `.env`:

```
SCORING_WEIGHTS_OVERRIDE=./data/weights-override.json
```

The `dominus backtest suggest-weights --apply` command writes this file
automatically based on backtest results. See [backtest docs](../../README.md#backtest--calibration)
for the two-gate activation process.

### Signal Thresholds

Each scoring signal uses tunable parameters. Defaults reflect the original
conservative tuning:

| Env Variable | Default | Signal | Purpose |
|-------------|---------|--------|---------|
| `SCORING_IDEAL_LENGTH` | `7` | Intrinsic | Ideal SLD character length |
| `SCORING_MAX_LENGTH` | `20` | Intrinsic | Max SLD length before score = 0 |
| `SCORING_MAX_VOLUME` | `1000000` | Commercial | Max monthly search volume ceiling |
| `SCORING_MAX_CPC` | `50` | Commercial | Max CPC ceiling |
| `SCORING_FLOOR_VALUE` | `500` | Market | Floor market value in EUR |
| `SCORING_HIGH_VALUE` | `10000` | Market | High market value in EUR |
| `SCORING_MAX_AGE_YEARS` | `20` | Expiry | Max domain age for expiry signal |
| `SCORING_MAX_BACKLINKS` | `1000` | Expiry | Max backlinks for expiry signal |
| `SCORING_MAX_WAYBACK` | `500` | Expiry | Max Wayback snapshots for expiry signal |
| `SCORING_BUY_MAX_RATIO` | `0.5` | Engine | suggestedBuyMax = expectedValue × this |
| `SCORING_LIST_PRICE_MULTIPLIER` | `2.5` | Engine | suggestedListPrice = expectedValue × this |
| `SCORING_BASE_MARKET_VALUE` | `500` | Engine | Base EUR value for expected value calc |
| `SCORING_CONFIDENCE_BASE` | `0.2` | Engine | Starting confidence with 1 signal |
| `SCORING_CONFIDENCE_PER_SIGNAL` | `0.3` | Engine | Confidence increment per extra signal |
| `SCORING_CONFIDENCE_CAP` | `0.8` | Engine | Absolute confidence cap |
| `SCORING_RECOMMEND_THRESHOLD` | `0.4` | Engine | Min weightedScore for recommendation |
| `BUY_MAX_ABSOLUTE_CAP` | `500` | Engine | Absolute cap on suggestedBuyMax (EUR) |

### TLD Bonuses

TLD bonuses are multipliers applied to the intrinsic signal. Defaults:

| TLD | Bonus |
|-----|-------|
| `.com` | 1.0 |
| `.ai` | 0.9 |
| `.io` | 0.85 |
| `.co` | 0.75 |
| `.net` | 0.65 |
| `.org` | 0.55 |
| All others | 0.3 |

Override via a JSON file:

```json
{
  ".com": 1.0,
  ".io": 0.9,
  ".xyz": 0.4,
  ".dev": 0.7
}
```

Set in `.env`:

```
TLD_BONUSES_PATH=./data/tld-bonuses.json
```

The file is merged with defaults — only the TLDs you specify are overridden.

### Adding a Custom Signal

To add a fifth signal (e.g. social media presence, PageRank, domain authority):

1. Create `src/scoring/signals/social-signal.ts`:

```typescript
import type { SignalOutput, ScoringInput } from '../../types/score.js';

export async function computeSocialScore(
  input: ScoringInput,
  provider: YourProvider,
  weight: number,
): Promise<SignalOutput> {
  // Your scoring logic here
  return { score, weight, details: {} };
}
```

2. Wire it in `src/scoring/scoring-engine.ts`:

```typescript
const social = await computeSocialScore(input, this.socialProvider, this.weights.social);
```

3. Add `social: number` to `ScoringWeights` in `src/scoring/weights.ts`.
4. Add the new weight to your `SCORING_WEIGHTS_OVERRIDE` JSON.

---

## Providers

### Swapping a Provider

Every provider is behind a TypeScript interface. To swap one:

1. Create a new implementation file (e.g. `src/providers/keyword/google-ads-provider.ts`)
2. Implement the interface:

```typescript
import type { KeywordProvider, KeywordMetrics } from './keyword-provider.js';

export class GoogleAdsKeywordProvider implements KeywordProvider {
  async getMetrics(term: string): Promise<KeywordMetrics> {
    // Call the Google Ads API here
    return { term, monthlySearchVolume: 5000, cpc: 3.5, competition: 0.6 };
  }
}
```

3. Swap the instance in `src/app/composition-root.ts`:

```typescript
// Before:
const keywordProvider = new ManualKeywordProvider(config.KEYWORD_DATA_PATH);
// After:
const keywordProvider = new GoogleAdsKeywordProvider(/* your config */);
```

That's it. The scoring engine, pipeline, and all consumers continue working
without modification.

### Available Provider Interfaces

| Interface | File | Methods |
|-----------|------|---------|
| `DnsProvider` | `src/providers/dns/dns-provider.ts` | `checkAvailability`, `checkBulk` |
| `RdapProvider` | `src/providers/rdap/rdap-provider.ts` | `confirm` |
| `TrademarkProvider` | `src/providers/trademark/trademark-provider.ts` | `search` |
| `KeywordProvider` | `src/providers/keyword/keyword-provider.ts` | `getMetrics` |
| `CompsProvider` | `src/providers/comps/comps-provider.ts` | `getSales` |
| `WhoisProvider` | `src/providers/whois/whois-provider.ts` | `checkAvailability` |
| `RegistrarProvider` | `src/providers/registrar/registrar-provider.ts` | `checkPrice`, `purchase`, `listDomains`, `getRenewalCost` |
| `Notifier` | `src/notifiers/notifier.ts` | `send` |

### Registrar Integration

The `RegistrarProvider` interface allows automated domain purchases. Built-in
implementations:

- `ManualRegistrarProvider` — returns no-op; you buy domains manually (default)
- `CloudflareRegistrarProvider` — uses Cloudflare API v4 (set `CLOUDFLARE_API_TOKEN`
  and `CLOUDFLARE_ACCOUNT_ID` in `.env`)

To add Namecheap, GoDaddy, or any other registrar:
1. Implement `RegistrarProvider`
2. Swap in `composition-root.ts`

---

## Trademark Matching

Trademark matching follows a conservative token-aware policy (see ADR-0012).
Three parameters control the matching behaviour:

| Env Variable | Default | Purpose |
|-------------|---------|---------|
| `TRADEMARK_MIN_TOKEN_LENGTH_FUZZY` | `4` | Minimum token length for Levenshtein-1 matching |
| `TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING` | `3` | Minimum mark token length for substring matching |
| `TRADEMARK_MAX_LEVENSHTEIN` | `1` | Maximum edit distance for fuzzy matching |

### Strict USPTO TLDs

The trademark gate treats `.com` and `.us` domains as US-jurisdiction assets.
For these TLDs, the USPTO provider is mandatory — if USPTO is unreachable,
the gate returns `Unverified` even if EUIPO responded cleanly. This list is
hardcoded in `src/trademark/trademark-gate.ts` (`STRICT_USPTO_TLDS`).

To add more TLDs to this list, edit the `STRICT_USPTO_TLDS` set. This is one
of the few remaining hardcoded values, chosen deliberately for safety.

---

## Pipeline Behaviour

| Env Variable | Default | Purpose |
|-------------|---------|---------|
| `DEFAULT_KEYWORD_TLD` | `.com` | TLD appended to bare keywords |
| `DNS_BULK_CONCURRENCY` | `10` | Concurrent DNS resolution requests |
| `WHOIS_LOOKUP_TIMEOUT` | `10000` | WHOIS socket timeout (ms) |
| `DROP_SCORE_THRESHOLD` | `25` | Score below which drop is considered (0-100) |
| `DROP_RENEWAL_HORIZON_DAYS` | `60` | Days before renewal for drop evaluation |
| `TM_CACHE_TTL_DAYS` | `7` | Trademark cache expiry in days |

---

## Notifications

DOMINUS supports multiple notification channels for renewal alerts and
watchlist events:

| Channel | Env Variables |
|---------|---------------|
| Console | Always active |
| Desktop | `NOTIFIER_DESKTOP_ENABLED=true` |
| Webhook | `NOTIFIER_WEBHOOK_URL` |
| Telegram | `NOTIFIER_TELEGRAM_BOT_TOKEN` + `NOTIFIER_TELEGRAM_CHAT_ID` |

Add a custom notifier by implementing the `Notifier` interface and adding it
in `src/notifiers/notifier-router.ts`.

---

## Deployment

See the [Deployment Guide](../deployment/README.md) for:
- Docker Compose profiles
- Reverse proxy configuration (nginx)
- systemd service unit
- PM2 ecosystem file
- Kubernetes manifests
- Security checklist
