# ADR-0090: The legal surface is server-owned data, and a launch gate guards it

## Metadata

| Field          | Value                                                     |
| -------------- | --------------------------------------------------------- |
| **Status**     | Accepted                                                  |
| **Date**       | 2026-10-19                                                |
| **Authors**    | Alessio Brillo                                            |
| **Deciders**   | Alessio Brillo                                            |
| **Supersedes** | —                                                         |
| **Relates to** | ADR-0025, ADR-0026, ADR-0027, ADR-0028, ADR-0030, ADR-0054, ADR-0083 |
| **Project**    | DOMINUS                                                   |

## Context

v1.2.0 shipped three legal pages in the SPA (`/terms`, `/privacy`,
`/impressum`). They were a good-faith first draft and they had three defects
that no test, no linter and no reviewer had caught:

1. **Wrong jurisdiction.** The notice was written for Germany ("Angaben gemäß
   § 5 TMG"). The operator of DOMINUS Cloud is an Italian economic operator,
   so the applicable rule is art. 7 of D.Lgs. 70/2003 (electronic commerce),
   not the German one — and the document named a legal regime the operator is
   not subject to.
2. **Placeholder identity.** The notice published `privacy@dominus.example`
   and no postal address. A legal notice with a placeholder is not a legal
   notice; it is worse than an absent one, because it looks compliant.
3. **Unreachable from the public surface.** The server-rendered public pages
   (`/public/domain/:domain`, `/public/for-sale/:domain`, `/public/compare/…`)
   carried no legal link at all. Art. 7 asks for *immediate* reachability
   from every page, not a link hidden behind a terms page.

The same release left three commercial obligations unmet, all recorded in
`docs/releases/cloud-launch-readiness.md`: no VAT handling beyond
`automatic_tax`, no data-subject export/erasure path, and no mechanical
answer to "may this deployment start selling?".

## Decision Drivers

1. **The operator identity is data, not code.** It changes when the operator
   changes, it must be identical on the SPA and on the server-rendered
   pages, and it must never require a code change to publish.
2. **The community edition is not the Cloud.** In a self-hosted deployment the
   deployer is the controller and the AGPL governs the software; publishing
   Cloud commercial terms there would be misleading, and publishing the
   operator's identity there would be wrong.
3. **A missing legal clause is invisible.** No reviewer notices a missing
   withdrawal clause, and no test fails because of one. The checks that
   matter here must be mechanical.
4. **The documents must be translatable later.** The i18n increment planned
   for v1.4.0 must be able to translate the legal text without rewriting
   components.
5. **No formal legal review is available now.** The decision to publish
   unreviewed text is a decision that must be written down, with its
   consequences, rather than an omission.

## Considered Options

### Option A: Keep the legal pages as React components

**Advantages:** no backend work, no public endpoint, the text lives next to
the components that render it.

**Disadvantages:** the operator identity becomes a build-time constant (a
release to change an address); the server-rendered pages cannot show the same
text without duplicating it in the view layer, and duplication is how the two
copies drift; translation would mean editing three components.

### Option B: The legal surface is server-owned structured data

The backend owns the documents and the identity, assembles them from the
configuration, and serves them as structured data. The SPA renders the
structure; the server-rendered pages render the identity in their footer.

**Advantages:** one source of truth; the identity is configuration; the
public pages and the SPA cannot drift; translation becomes a catalogue
problem, not a component problem; the guardrail can inspect the published
text.

**Disadvantages:** a public endpoint exists; the frontend depends on it.

### Option C: Publish the legal documents on an external static site

**Advantages:** no code at all.

**Disadvantages:** the identity and the terms would live outside the product,
so the footer of every public page would link to another origin — and the
product could not be self-hosted without pretending to be someone else. It
also means the terms of a self-hosted deployment are decided by the operator
of a site the deployer never sees.

## Decision

**Option B.**

- `src/services/legal-content.ts` holds the three documents as structured
  data (title, scope, sections with paragraphs and bullets) and assembles
  them per deployment mode. `src/services/legal-identity.ts` reads the
  identity from the configuration and decides whether it is complete.
- The identity comes from the `LEGAL_*` environment variables
  (`LEGAL_ENTITY_NAME`, `LEGAL_REGISTERED_ADDRESS`, `LEGAL_VAT_ID`,
  `LEGAL_REA_NUMBER`, `LEGAL_PEC`, `LEGAL_CONTACT_EMAIL`,
  `LEGAL_PRIVACY_EMAIL`, `LEGAL_SUPERVISORY_AUTHORITY`). They are optional:
  a self-hosted deployment publishes documents that describe the deployment,
  not the DOMINUS operator.
- The documents are served unauthenticated at `GET /public/legal` and
  rendered by the SPA at `/legal-notice`, `/terms` and `/privacy`. The German
  `/impressum` route redirects to `/legal-notice`.
- Every server-rendered public page carries the legal footer
  (`src/api/views/legal-footer.ts`): the operator identity and the links to
  the three documents. The footer context is injected once at boot, because
  the alternative — a parameter on five renderers — makes it easy to forget
  one page.
- The community edition and the cloud edition publish **different**
  documents. The commercial terms (payments, withdrawal, SLA, liability
  caps) exist only in the cloud documents; the community documents describe
  the AGPL licence and the self-hosted data flow.
- `scripts/check-legal-placeholders.mjs` runs in the gate and fails when:
  a placeholder appears in the published text; the notice stops rendering an
  identity field that art. 7 requires; a required clause (withdrawal,
  reverse charge, sub-processors, supervisory authority) disappears; the
  public pages stop carrying the footer or the SPA stops registering a
  route; an identity variable leaves the configuration or `.env.example`.
- The runtime counterpart is the launch gate (`npm run launch:check`),
  which runs the same checks against a live deployment with the real
  configured values.

### The texts are drafts, and that is a recorded decision

No formal legal review has been performed on the three documents. They were
drafted against the applicable rules (art. 7 D.Lgs. 70/2003; the Consumer
Code for withdrawal, art. 52 and 59; art. 13/14/28 GDPR; the VAT rules for
reverse charge and OSS) and they are published in English, with the Italian
version stated as prevailing.

The consequences are accepted for this release and are not hidden:

- the launch gate refuses a deployment whose identity is missing or still
  holds a placeholder, so the failure mode is "not launchable", not
  "publishing a placeholder";
- the paid tiers stay behind the existing fail-closed billing gate
  (`BILLING_NOT_CONFIGURED` when Stripe is not configured) until the
  operator has a fiscal position — enabling collection without one would be
  a business decision, not an engineering one;
- a formal review remains open work, tracked next to the third-party
  security audit.

## Consequences

### Positive

- The public pages identify the operator, as the law requires, and the
  identity is a configuration change rather than a release.
- A regression in the legal surface fails the gate instead of waiting for a
  reader to notice.
- The v1.4.0 i18n increment translates a catalogue, not a component tree.
- A self-hosted deployment no longer shows an operator identity that does not
  exist for it.

### Negative

- A public endpoint exposes the operator identity and the full text of the
  documents. That is the point of the requirement, and the documents contain
  nothing that is not published on the same pages anyway.
- The legal text lives in the repository, so it is versioned, diffed and
  reviewed in the open. For an unpublished draft that is the desired
  transparency; once the text is validated by a lawyer, the operator may
  prefer to move it out of the repository. That is a deliberate later
  decision, not an oversight.
- English only. German and Italian versions are deferred to the i18n
  increment, with the English text prevailing in the meantime.

## Links

- `src/services/legal-content.ts` — the documents.
- `src/services/legal-identity.ts` — the identity and its completeness.
- `src/api/views/legal-footer.ts` — the footer of the public pages.
- `scripts/check-legal-placeholders.mjs` — the repository guardrail.
- `docs/releases/cloud-launch-readiness.md` — the launch blockers and the
  order in which they must be cleared.
