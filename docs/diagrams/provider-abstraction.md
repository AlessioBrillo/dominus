# Provider Abstraction Pattern

Every external dependency is behind a TypeScript interface. Swapping a provider
is a one-file change in `src/app/composition-root.ts`.

```mermaid
flowchart TB
    subgraph Core[Core Logic - No Provider Dependencies]
        PE[Pipeline Orchestrator]
        SE[Scoring Engine]
        TG[Trademark Gate]
        PM[Portfolio Manager]
    end

    subgraph Interfaces[Provider Interfaces]
        DNS[DnsProvider]
        RDAP[RdapProvider]
        WHOIS[WhoisProvider]
        TM[TrademarkProvider]
        KW[KeywordProvider]
        CP[CompsProvider]
        REG[RegistrarProvider]
    end

    subgraph Community[Community Edition Implementations]
        UR[UnboundResolver<br/>+ NodeDnsFallback]
        PR[PublicRdapProvider<br/>+ FailoverRdapProvider]
        NW[NodeWhoisProvider]
        UP[UsptoCasesProvider<br/>+ TsdrTrademarkProvider]
        EP[EuipoProvider]
        MK[ManualKeywordProvider<br/>(local JSON)]
        GS[GoogleSuggestKeywordProvider]
        MC[ManualCompsProvider<br/>(local CSV)]
        MR[ManualRegistrarProvider]
        WB[CdxProvider<br/>(Wayback history)]
    end

    subgraph Optional[Optional Paid Implementations]
        GA[GoogleAdsProvider<br/>(needs Google Ads credentials)]
        NB[NameBioProvider<br/>(needs NameBio API access)]
        CF[CloudflareRegistrarProvider<br/>(only real registrar adapter)]
    end

    subgraph CrossCutting[Cross-Cutting Decorators]
        CACHED[CachedProvider<br/>(configurable TTL)]
        RETRY[RetryingProvider<br/>(exponential backoff + jitter)]
        RATE[RateLimiter<br/>(token bucket)]
        CIRCUIT[CircuitBreaker<br/>(max failures / time window)]
        FAILOVER[FailoverRdapProvider<br/>(primary → fallback)]
    end

    Core -.-> Interfaces
    Interfaces --> Community
    Interfaces --> Optional
    Interfaces --> CrossCutting
    CrossCutting --> Community
    CrossCutting --> Optional

    style Core fill:#1a1a2e,stroke:#0f3460,color:#eee
    style Interfaces fill:#16213e,stroke:#533483,color:#eee
    style Community fill:#0f3460,stroke:#16213e,color:#eee
    style Optional fill:#1a1a2e,stroke:#16213e,color:#ddd
    style CrossCutting fill:#2d1b69,stroke:#533483,color:#eee
```

Only two registrar adapters exist: `ManualRegistrarProvider` (no-op) and
`CloudflareRegistrarProvider`. The other marketplace adapters (Afternic,
Sedo, Dan.com, GoDaddy Auctions) were removed in v1.1.0 because they were
never verified against the vendors' APIs — see
[ADR-0082](../adr/0082-removal-of-unimplemented-features.md). They return
when API access exists.

## Wiring in Composition Root

All providers are wired in a single file: `src/app/composition-root.ts`.

```typescript
// Community edition wiring
const euipoTmProvider = new CachedTrademarkProvider(
  new RetryingTrademarkProvider(
    new EuipoProvider({
      clientId: config.EUIPO_CLIENT_ID,
      clientSecret: config.EUIPO_CLIENT_SECRET,
      authUrl: config.EUIPO_AUTH_URL,
      apiUrl: config.EUIPO_API_URL,
      pageSize: config.EUIPO_PAGE_SIZE,
      maxPages: config.EUIPO_MAX_PAGES,
      rateLimiter: euipoRateLimiter,
    }),
    {},
    euipoCircuitBreaker,
  ),
  providerCacheRepo,
  'EUIPO',
  config.TM_CACHE_TTL_DAYS,
  config.PROVIDER_MEMORY_CACHE_SIZE,
);
```
