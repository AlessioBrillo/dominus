# Compliance matrix — what obligation is met where

This is the agenda for the external review of the paid Cloud launch. Each row
names an obligation, the place that satisfies it today, and the evidence. A
blank "Evidence" cell is an open item for the reviewer, not a claim that the
obligation is met.

| Obligation | Where it is satisfied | Evidence / status |
|---|---|---|
| art. 7 D.Lgs. 70/2003 — identity of the service provider | `/legal-notice`, server-rendered footer | published; real S.r.l. registration data still to be supplied by the operator |
| art. 2250 c.c. — company name, seat, REA, PEC, share capital on the website | `src/services/legal-identity.ts`, legal notice | fields enforced for `entityKind=company`; values configured at deploy time |
| Registro Imprese / Partita IVA / legal form | `LEGAL_*` configuration, legal notice | open until the company is registered |
| VAT regime — ordinary for an S.r.l. | `validateIdentity`, `LEGAL_VAT_REGIME` | first-party check; company + forfettario refused at boot |
| Reverse charge for EU businesses | paid terms §3, checkout VAT ID collection | implemented via Stripe Tax `tax_id_collection` |
| Electronic invoicing — SDI code / PEC | paid terms §6, first-party contract step | field collected before checkout; storage in `contract_acceptances.billing_code`; the issuing flow with the commercialista is still a human item |
| art. 49 Consumer Code — pre-contractual information | paid terms, pricing section, contract step | implemented; user-facing text is English only |
| art. 52-59 Consumer Code — 14-day withdrawal | paid terms §9; `CHECKOUT_TERMS_CONSENT_MESSAGE` | implemented; no art. 59(1)(o) waiver |
| art. 57(3) Consumer Code — pro-rata on immediate performance | contract step, acceptance in ledger | implemented as a separate, unticked request |
| Annex I Part B — model withdrawal form | paid terms §9 | present |
| art. 128-135 Consumer Code — legal guarantee | paid terms §10 | present |
| art. 1341 c.c. — specific approval of clauses limiting a business customer's rights | contract step, `art1341` acceptance | implemented |
| art. 33/49 Consumer Code — clear and comprehensible information for Italian consumers | English-only binding text | **open**: Italian courtesy version recommended; counsel to confirm |
| art. 13-14 GDPR — privacy information | `/privacy` | published |
| art. 28 GDPR — data processing agreement | generated at `/public/dpa`, accepted via ledger | generated from real identity; signable/annexed copy and counsel review open |
| art. 30 GDPR — records of processing | `docs/legal/ropa.md` | present; must be re-issued in the S.r.l.'s name |
| art. 32 GDPR — security of processing | privacy notice §7, DPA §5 | implemented |
| art. 44 GDPR — transfers | `docs/legal/transfer-register.md`, privacy notice §3 | DPF certification status for Backblaze/Auth0 to be verified before publication; `[date]` and `[SMTP provider]` still open |
| ePrivacy — browser storage | privacy notice §4 | no non-essential cookies; list matches the code |
| EAA / Directive (EU) 2019/882 — accessibility of e-commerce services | `/accessibility`, WCAG smoke gate | microenterprise exemption documented; voluntary statement published |
| ODR / ADR information | paid terms §17 | ODR platform closure of 20 July 2025 recorded; ADR entities via ECC Italy |
| Waitlist consent proof (version, timestamp, double opt-in) | `waitlist_signups`, `/public/waitlist`, first-party form | implemented; external `CLOUD_WAITLIST_URL` remains an operator choice |
| For-sale ownership claims | DNS TXT verification endpoints, conditional `Offer` JSON-LD | implemented; token stored hashed, no `Offer` until verified |
| Trademark rights to the name | `docs/legal/trademark-search.md` | open: formal EUIPO/TMview search and filing in classes 9 and 42 |
| AGPL §13 — source offer for network use | every legal document and both footers | implemented |
| Backup and retention promises | `prune-handler.ts`, privacy notice §5 | 12-month offer retention now enforced; 30-day backups documented |
| Contract acceptance evidence | `contract_acceptances`, `/api/v1/contracts/accept` | implemented and covered by tests |

## How to use this matrix

The reviewer marks each row *confirmed*, *changes requested* or *not
applicable*, and records the date. Nothing in this file is a legal opinion;
it is a map of where the engineering work claims to satisfy an obligation.
