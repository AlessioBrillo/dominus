# Scoring Engine

```mermaid
flowchart TB
    subgraph Input[Scoring Input]
        DOMAIN["domain, sld, tld<br/>renewalCost (optional)"]
    end

    subgraph Signals[4 Signal Computation]
        direction TB
        IS[Intrinsic Signal<br/>length, pronounceability<br/>hyphens/numbers penalty<br/>TLD bonus]
        CS[Commercial Signal<br/>keyword volume × CPC<br/>via KeywordProvider]
        MS[Market Signal<br/>comparable NameBio sales<br/>via CompsProvider]
        ES[Expiry Signal<br/>domain age, backlinks<br/>Wayback history]
    end

    subgraph Weighting[Dynamic Weight Resolution]
        AVAIL[SignalAvailability<br/>which signals have data?]
        WEIGHTS["resolveEffectiveWeights()<br/>redistribute weights<br/>from missing → available signals"]
        THOLDS["computeEffectiveThresholds()<br/>adjust recommend/confidence<br/>gates based on coverage"]
    end

    subgraph Core[Score Computation]
        WSUM["weightedScore =<br/>Σ(signal_score × effective_weight)"]
        CONF["confidence =<br/>f(coverage, intrinsic_quality)"]
        EV["expectedValue =<br/>weightedScore × baseMarketValue ×<br/>(1 + medianSalePrice / baseMV × 0.5)"]
        BUYMAX["suggestedBuyMax =<br/>min(EV × buyMaxRatio - holdingCost,<br/>absoluteCap)"]
        LISTPRICE["suggestedListPrice =<br/>expectedValue × listPriceMultiplier"]
    end

    subgraph Verdict[Buy / Pass Decision]
        RECOMMEND["recommended =<br/>confidence ≥ confidenceThreshold<br/>AND weightedScore ≥ recommendThreshold"]
    end

    subgraph Output[ScoreResult]
        OR["expected_value, confidence<br/>suggested_buy_max, suggested_list_price<br/>bidRange: {conservative, aggressive}<br/>breakdown: {intrinsic, commercial, market, expiry}<br/>effectiveWeights, signalStatus"]
    end

    Input --> IS
    Input --> CS
    Input --> MS
    Input --> ES

    IS --> AVAIL
    CS --> AVAIL
    MS --> AVAIL
    ES --> AVAIL

    AVAIL --> WEIGHTS
    AVAIL --> THOLDS

    IS --> WSUM
    CS --> WSUM
    MS --> WSUM
    ES --> WSUM

    WEIGHTS --> WSUM
    THOLDS --> RECOMMEND
    IS --> CONF
    AVAIL --> CONF

    WSUM --> EV
    EV --> BUYMAX
    EV --> LISTPRICE
    EV --> RECOMMEND
    CONF --> RECOMMEND
    CONF --> BUYMAX

    BUYMAX --> OR
    LISTPRICE --> OR
    EV --> OR
    CONF --> OR
    WSUM --> OR
    RECOMMEND --> OR

    style Input fill:#1a1a2e,stroke:#16213e,color:#eee
    style Signals fill:#16213e,stroke:#0f3460,color:#eee
    style Weighting fill:#0f3460,stroke:#533483,color:#eee
    style Core fill:#16213e,stroke:#533483,color:#eee
    style Verdict fill:#2d1b69,stroke:#533483,color:#eee
    style Output fill:#1a1a2e,stroke:#16213e,color:#eee
```

## Signal Details

| Signal | Computation | Data Source | Conservative Tuning |
|--------|-------------|-------------|-------------------|
| **Intrinsic** | Domain length score + pronounceability + hyphen/numbers penalty + TLD bonus | Local heuristics | TLD bonus capped at 0.15; hyphen penalty floors score |
| **Commercial** | Search volume × CPC (normalised) | `KeywordProvider` | Falls back to 0 (no boost) if provider unavailable |
| **Market** | Comparable sales median + recency-weighted average | `CompsProvider` | Falls back to 0; strong signal when available but capped |
| **Expiry** | Age decile + backlinks log-scaled + Wayback age | Closeout CSV import | Only fires for expired/closeout domains |

## Weight Redistribution

When one or more signals lack data, their weight is redistributed proportionally
among the available signals. The intrinsic signal always retains at least its
base weight (no redistribution below the intrinsic floor). This ensures the
engine never produces a score from zero data.

## Confidence Formula

```
coverage = intrinsic_weight +
           (commercial_available ? commercial_weight : 0) +
           (market_available ? market_weight : 0) +
           (expiry_available ? expiry_weight : 0)

signal_confidence = (coverage - intrinsic_min) / (1 - intrinsic_min)
                    × (confidence_cap - confidence_base)
                    × (1 - intrinsic_quality_influence)

quality_boost = intrinsic_score × intrinsic_quality_influence
                × (confidence_cap - confidence_base)

confidence = min(confidence_cap, confidence_base + signal_confidence + quality_boost)
```
