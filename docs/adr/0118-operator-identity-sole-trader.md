# ADR-0118: Sole trader at first paid launch

## Metadata

| Field          | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| **Status**     | Accepted                                                     |
| **Date**       | 2026-11-27                                                   |
| **Authors**    | Alessio Brillo                                               |
| **Deciders**   | Alessio Brillo                                               |
| **Supersedes** | ADR-0109 (operator form only)                                |
| **Relates to** | ADR-0108, ADR-0111, ADR-0113                                 |

## Context

ADR-0109 recorded the operator as an Italian S.r.l. Two days later ADR-0113
decided a registered sole trader under the ordinary VAT regime, but did not
mark ADR-0109 as superseded. The launch-readiness document and the DPA template
still describe an S.r.l., so the published legal surface can disagree with the
operator's actual registration.

The code already distinguishes `individual`, `sole_trader` and `company` in
`src/services/legal-identity.ts`: paid mode refuses `individual`, accepts
`sole_trader`, and refuses `company` with the forfettario regime. No code
change is needed. What is needed is one authoritative decision.

## Decision

1. The first paid operator is an Italian **registered sole trader**
   (`LEGAL_ENTITY_KIND=sole_trader`) under the **ordinary VAT regime**
   (`LEGAL_VAT_REGIME=ordinary`), as decided in ADR-0113.
2. ADR-0109 is superseded **only on the operator form**. Its other decisions —
   English as the binding language and first-party contract evidence — remain
   in force.
3. The legal documents, DPA template, launch checklist and runbooks are
   updated to say "sole trader" wherever they currently say "S.r.l.".
   A company may be formed later under a new ADR, never silently by a config
   change.
4. `launch:check --paid` continues to refuse a boot without a complete
   identity (VAT ID, registered address, contacts). An incomplete identity is
   never replaced by a placeholder.

## Considered alternatives

| Alternative                       | Why rejected                                                     |
| --------------------------------- | ---------------------------------------------------------------- |
| Keep both ADRs as valid           | The published notice would name a company that does not exist.   |
| Form an S.r.l. before first revenue | Notary and accounting costs arrive before demand (ADR-0113).    |
| Operate as a natural person       | Paid mode deliberately refuses `individual` (ADR-0108).          |

## Consequences

- The accountant must confirm OSS, the invoice series and the reverse-charge
  wording for a sole trader before `--paid` is enabled.
- The English-only residual risk of ADR-0108 is unchanged and still requires
  legal review before Italian consumers can be sold to.
- `check:legal-placeholders` and `launch:check` are the mechanical guards;
  they cannot confirm the registration itself.
