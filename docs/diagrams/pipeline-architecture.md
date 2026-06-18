# Pipeline Architecture

```mermaid
flowchart TB
    subgraph Input[Input Sources]
        KC[Keyword Combinations]
        BN[Brandable Names]
        CC[Closeout CSV Import]
    end

    subgraph Pipeline[5-Stage Pipeline]
        direction TB
        S1["1. Candidate Generation<br/>Generate domain candidates<br/>from keyword combos / CSVs"]
        S2["2. DNS Pre-filter<br/>Bulk availability check<br/>via Node.js dns module"]
        S3["3. RDAP Confirmation<br/>Precise availability +<br/>premium detection"]
        S4["4. Scoring Engine<br/>Heuristic valuator with<br/>4 signals + confidence"]
        S5["5. Trademark Gate<br/>Mandatory USPTO + EUIPO<br/>check (non-negotiable)"]

        S1 --> S2
        S2 --> S3
        S3 --> S4
        S4 --> S5
    end

    subgraph Output[Decision Output]
        VP["Verdict: Buy / Pass<br/>expected_value, confidence<br/>suggested_buy_max, suggested_list_price"]
    end

    subgraph Async[Async Execution]
        JQ[("Job Queue<br/>(SQLite/PostgreSQL)")]
        JW[Job Worker<br/>Polls & Executes]
    end

    Input --> S1
    S5 --> VP

    S1 -.-> JQ
    S2 -.-> JQ
    S3 -.-> JQ
    S4 -.-> JQ
    S5 -.-> JQ
    JQ -.-> JW
    JW -.-> VP

    style Input fill:#1a1a2e,stroke:#16213e,color:#eee
    style Pipeline fill:#16213e,stroke:#0f3460,color:#eee
    style Output fill:#1a1a2e,stroke:#16213e,color:#eee
    style Async fill:#1a1a2e,stroke:#16213e,color:#eee
    style VP fill:#0f3460,stroke:#533483,color:#eee
```

## Stage Details

| Stage | Provider | Key Logic |
|-------|----------|-----------|
| 1. Candidate Generation | — | Keyword combos, brandable patterns, closeout CSV parser |
| 2. DNS Pre-filter | `NodeDnsProvider` | Resolves A/AAAA records; registered = dropped |
| 3. RDAP Confirmation | `PublicRdapProvider` + `FailoverRdapProvider` | RDAP lookup → available + not premium |
| 4. Scoring Engine | `ManualKeywordProvider`, `ManualCompsProvider` | 4 signals → weighted aggregate → expected value |
| 5. Trademark Gate | `UsptoProvider` + `EuipoProvider` | Fuzzy token matching + exact match; any hit = blocked |
