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
        ND[NodeDnsProvider]
        PR[PublicRdapProvider<br/>+ FailoverRdapProvider]
        NW[NodeWhoisProvider]
        UP[UsptoProvider]
        EP[EuipoProvider]
        MK[ManualKeywordProvider<br/>(local JSON)]
        MC[ManualCompsProvider<br/>(local CSV)]
        MR[ManualRegistrarProvider]
    end

    subgraph Cloud[Cloud / Paid Implementations]
        GDP[GoogleDnsProvider<br/>(stub)]
        ARD[ARdapProvider<br/>(stub)]
        WX[WhoisXmlProvider<br/>(stub)]
        GKP[GoogleAdsKeywordProvider<br/>(stub)]
        NB[NameBioCompsProvider<br/>(stub)]
        NAME[NamecheapRegistrarProvider]
        GD[GoDaddyRegistrarProvider]
        PB[PorkbunRegistrarProvider]
        NS[NameSiloRegistrarProvider]
        DD[DynadotRegistrarProvider]
        CF[CloudflareRegistrarProvider]
    end

    subgraph CrossCutting[Cross-Cutting Decorators]
        CACHED[CachedProvider<br/>(configurable TTL)]
        RETRY[RetryableProvider<br/>(exponential backoff + jitter)]
        RATE[RateLimitedProvider<br/>(token bucket)]
        CIRCUIT[CircuitBreakerProvider<br/>(max failures / time window)]
        FAILOVER[FailoverProvider<br/>(primary → fallback)]
    end

    Core -.-> Interfaces
    Interfaces --> Community
    Interfaces --> Cloud
    Interfaces --> CrossCutting
    CrossCutting --> Community
    CrossCutting --> Cloud

    style Core fill:#1a1a2e,stroke:#0f3460,color:#eee
    style Interfaces fill:#16213e,stroke:#533483,color:#eee
    style Community fill:#0f3460,stroke:#16213e,color:#eee
    style Cloud fill:#1a1a2e,stroke:#16213e,color:#ddd
    style CrossCutting fill:#2d1b69,stroke:#533483,color:#eee
```

## Wiring in Composition Root

All providers are wired in a single file: `src/app/composition-root.ts`.

```typescript
// Community edition wiring
providers: {
  dns: new NodeDnsProvider(config.dns),
  rdap: new CachedProvider(
    new FailoverRdapProvider([primaryRdap, ...fallbacks]),
    { ttl: config.cache.rdapTtl }
  ),
  trademark: new CachedProvider(
    new RetryableProvider(
      new CircuitBreakerProvider(
        new UsptoProvider(config.trademark.uspto),
        circuitConfig
      ),
      retryConfig
    ),
    { ttl: 7 * 24 * 60 * 60 * 1000 } // 7-day cache
  ),
  keyword: new ManualKeywordProvider(keywordData),
  comps: new ManualCompsProvider(compsData),
}

// DOMINUS Cloud wiring (same interface, different implementations)
providers: {
  keyword: new GoogleAdsKeywordProvider(googleAdsClient),
  comps: new NameBioCompsProvider(namebioClient),
}
```
