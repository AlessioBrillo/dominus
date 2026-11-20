# ADR-0108: A waitlist, not a shop — the legal posture of the community soft launch

- Status: Accepted
- Date: 2026-11-20
- Deciders: project maintainer
- Related: [ADR-0090](0090-legal-surface-and-launch-gate.md),
  [ADR-0100](0100-launch-gate-profiles-and-evidence.md),
  [ADR-0103](0103-one-subscription-per-tenant.md),
  [ADR-0106](0106-launch-posture-of-the-saas-surface.md),
  [ADR-0107](0107-trust-boundary-of-a-paying-tenant.md)

## Context

The managed edition has a working checkout, a billing service, a metering
system and a complete legal text. Having the code is not the same as being
able to sell.

The operator is a natural person. The business does not yet exist: there is no
Registro Imprese registration, no REA number, no PEC, no Partita IVA, and the
accountant has not confirmed the VAT regime. Until those facts exist, the
operator cannot issue an Italian electronic invoice, cannot identify itself as
the economic operator under art. 7 of Legislative Decree 70/2003, and cannot
make truthful statements about VAT. Publishing a price, a withdrawal policy
and a checkout under those conditions is not a launch: it is a representation
about a contract the operator is not yet able to conclude.

Two further constraints shape the legal text:

1. The published documents are available in English only. The operator is in
   Italy and the intended customers include Italian consumers. An English
   translation of a statutory disclosure is comprehensible to many, but it is
   not the language a consumer would expect and a court may not treat it as
   equivalent. The documents must not claim that an Italian version exists or
   prevails.
2. The operator decided **not** to rely on the art. 59(1)(o) Consumer Code
   waiver of the withdrawal right for a digital service supplied immediately.
   For a service supplied over time, that waiver is doubtful anyway. The
   consumer keeps the 14-day right and, when performance starts at the
   consumer's request, pays only the proportional part of the service supplied
   (art. 57(3)). A checkout that tells the consumer the opposite would be an
   unfair term and would misdescribe the operator's own policy.

## Decision

1. **The community edition is the public soft launch.** The hosted edition is
   a waitlist: a destination for an email address and an honest statement that
   nothing can be bought yet. The landing page, the signup page and the legal
   documents all say so, and no price is published in that mode.
2. **Paid mode is a separate, explicit flag.** `CLOUD_PAID_ENABLED` defaults to
   `false`. Checkout, plan changes and self-serve workspace creation are
   refused while it is false, even when Stripe keys are present in the
   environment. A Stripe key is a capability, not a decision to sell.
3. **Paid mode fails closed on identity.** Turning the flag on requires cloud
   topology and an operator that is a `sole_trader` or a `company`, with VAT
   ID, register office, REA number and PEC. The process exits instead of
   serving a paid checkout under an incomplete notice. A natural person may
   run the website and the waitlist, but may not sell the service.
4. **Three service states instead of two.** `buildLegalContent` distinguishes
   `community`, `cloud_waitlist` and `cloud_paid`; the paid terms are dormant
   until the last state. The consumer withdrawal clause, the reverse charge,
   the VAT description and the business liability clauses belong to the paid
   documents only.
5. **The consumer keeps the statutory rights.** The paid terms grant 14 days
   of withdrawal, a pro-rata charge, a model withdrawal form, the legal
   guarantee under arts. 128-135 of the Consumer Code, a durable medium for
   the contract information and the specific approval required by art. 1341
   c.c. for the business clauses. No waiver under art. 59(1)(o) is requested
   at checkout or in the documents.
6. **English only, honestly stated.** There is no Italian version. Every
   document says that the English text is the only binding version; nothing
   claims an Italian original prevails. The residual risk described below is
   accepted for the community launch, not hidden.
7. **A security contact is published, when configured.**
   `/.well-known/security.txt` is generated from the operator's contact at
   boot, expires one year after generation, and returns 404 when no contact
   exists rather than publishing an empty address.

## Consequences

- A visitor to the public site can tell, without reading the source, whether
  the service is on sale. The same flag drives the API, the SPA and the
  documents, so they cannot silently disagree.
- Existing workspaces and live subscriptions on a deployment keep working when
  paid mode is off: only the doors that create or change a sale are closed.
- Turning paid mode on still requires the operator's registration, the
  accountant's VAT confirmation, a data processing agreement with annexes and
  signatures, and a review of the consumer-facing texts. Those are
  preconditions of the release, not of a feature flag.
- The launch gate applies different profiles: a Cloud deployment collecting a
  waitlist needs a name, an address and contacts; a paid Cloud additionally
  needs the business register data and a live trademark canary. `--paid` and
  `CLOUD_PAID_ENABLED=true` select the stricter profile.

## Residual risks

- **Language.** An Italian consumer reads the statutory disclosures in
  English. The operator accepts the risk that a court may require an Italian
  text for a consumer contract. Before the paid launch, a lawyer must confirm
  whether an Italian version of the pre-contract information and of the
  withdrawal form is required; if so, it becomes the version that prevails for
  Italian consumers, and the documents say so.
- **Unreviewed text.** The documents are drafted from the statutory references
  without formal legal review. A provision may be inaccurate even though it
  is published consistently.
- **Transfers.** The standard contractual clauses are named, but the transfer
  impact assessments for the US sub-processors are not complete.
- **Fiscal facts.** The ordinary VAT regime, 22% Italian rate, OSS for B2C EU
  and reverse charge for B2B EU are the assumptions used to draft the text.
  They are not confirmed until the accountant signs off, and the regime may
  change what the paid documents can say about prices.
- **Data processing agreement.** The art. 28 GDPR agreement is not published
  yet. No business customer can be onboarded on the paid service until it is.

None of these risks is closed by this decision. They are the list of gates the
paid release must pass, and `npm run launch:check --paid` fails on the parts
that can be checked mechanically.
