# Public PWA launch operations

Status: **operator runbook — Phase A (free public PWA)**. This is the
zero-precondition checklist for putting the installable PWA at a canonical
origin and inviting design partners to use it. Paid mode, the fiscal position
and the third-party security audit are **not** gates for the free PWA
([ADR-0117](../adr/0117-mobile-release-sequence.md)); they remain gates for
DOMINUS Cloud with paid subscriptions ([ADR-0108](../adr/0108-waitlist-not-a-shop.md),
[ADR-0112](../adr/0112-the-first-real-customer.md),
[ADR-0118](../adr/0118-operator-identity-sole-trader.md),
[audit-scope.md](../security/audit-scope.md)). The canonical origin, the
launch gate and the Cloud-topology checks in this runbook are Phase A work.

The placeholders used below are declared in the preconditions table:
`<your-domain>` is the registered domain you control, and `<your-email>` is a
real, monitored mailbox on that domain. In commands, `<url>` is the canonical
origin and `<version>` is the release version being evidenced.

## Preconditions from zero

| Precondition | Why Phase A needs it | How to satisfy it |
|---|---|---|
| Canonical domain | Canonical URLs, Open Graph data, the sitemap and the launch gate all read `PUBLIC_APP_URL`. The old `dominus.app` is parked and must not be published as the origin. | Register `<your-domain>` and serve the SPA at `https://app.<your-domain>`. Configuration: [`src/config.ts`](../../src/config.ts), [`.env.example`](../../.env.example). |
| Hetzner / hosting | The Cloud topology runs on two nodes; [first-apply.md](../deployment/first-apply.md) puts the fixed cost at approximately €15/month, plus the domain and usage-dependent egress and storage. Use a separate staging project, never the production one. | Follow [first-apply.md](../deployment/first-apply.md): Hetzner project, SSH key, two Backblaze B2 buckets and remote Terraform state. The state is a secret store; see [secrets.md](../operations/secrets.md). |
| SMTP relay with a verified sender | With `SIGNUP_EMAIL_VERIFICATION=required` (the default) signup **refuses** to create a workspace when `SMTP_URL` is unset: an inert workspace whose verification link cannot be delivered is unusable. The first-party waitlist also needs a mail transport ([legal-surface.md](../legal/legal-surface.md)). | Configure `SMTP_URL` with the relay's connection URL and set `SMTP_FROM` to `DOMINUS <your-email>` with a sender verified at the relay. [ADR-0107](../adr/0107-trust-boundary-of-a-paying-tenant.md). |
| DNS and TLS | The gate probes the public origin over HTTPS and fails a public deployment served only over HTTP. | Point the A record at the app node; Caddy obtains the Let's Encrypt certificate on the first HTTPS request. Ports 80 and 443 must reach the node. See [first-apply.md](../deployment/first-apply.md). |
| VAPID keypair | Both keys are required to enable the browser push channel; without them the push routes return 404 and no notification is sent. | Generate with `node scripts/generate-vapid-keys.mjs` ([script](../../scripts/generate-vapid-keys.mjs)). Set `VAPID_SUBJECT` to `mailto:<your-email>` on the real domain — override the shipped development-only default (`mailto:hello@localhost`). [ADR-0116](../adr/0116-mobile-device-sessions-and-push.md). |
| Basic operator identity for the Cloud waitlist | `launch:check --cloud` requires a project identity: name, registered address, contact address and privacy contact. Business fields (VAT ID, register office, REA, PEC) are required only with `--paid` or `CLOUD_PAID_ENABLED=true`. | Set `LEGAL_ENTITY_KIND=individual` plus real `LEGAL_ENTITY_NAME`, `LEGAL_REGISTERED_ADDRESS`, `LEGAL_CONTACT_EMAIL` and `LEGAL_PRIVACY_EMAIL` values. No fictitious business identity. [legal-surface.md](../legal/legal-surface.md). |
| Developer accounts and a macOS runner | Apple Developer, Google Play and the iOS build runner belong to store submission, not to a public web app. **NOT needed now.** | Budget them in Phase C only. [ADR-0117](../adr/0117-mobile-release-sequence.md), [mobile-release.md](mobile-release.md). |
| Design partners / waitlist | A PWA without users gives no activation evidence. The first-party waitlist stores an address, consent version, acceptance time and double opt-in when `CLOUD_WAITLIST_URL` is unset and a mailer exists. | Keep the waitlist reachable on `<your-domain>`; recruit design partners from it and the communities listed in [founding-cohort.md](founding-cohort.md). |

## Procedure

1. **Register and point the canonical domain.** Use `https://app.<your-domain>`
   as the exact browser origin. Do not publish `dominus.app`: it is parked.
2. **Generate the VAPID keypair** from the repository root:

   ```bash
   node scripts/generate-vapid-keys.mjs
   ```

   The script prints `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Store the
   private key in the deployment's secret store; the public key is returned to
   the browser by `GET /api/v1/mobile/push`.
3. **Set the environment where the deployment's environment is defined** (on
   the app node or with the environment loaded into the shell). All names exist
   in [`src/config.ts`](../../src/config.ts) and are listed in
   [`.env.example`](../../.env.example).

   | Variable | Phase A value |
   |---|---|
   | `PUBLIC_APP_URL` | `https://app.<your-domain>` |
   | `CORS_ORIGIN` | `https://app.<your-domain>,capacitor://localhost,https://localhost` |
   | `SMTP_URL` | the connection URL issued by your SMTP relay |
   | `SMTP_FROM` | `DOMINUS <your-email>` |
   | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | the two values printed in step 2 |
   | `VAPID_SUBJECT` | `mailto:<your-email>` on `<your-domain>`; override the shipped development-only default |
   | `CLOUD_PAID_ENABLED` | `false` — it must stay false. No price, checkout or self-serve paid workspace is enabled by Stripe keys. |
   | `SIGNUP_EMAIL_VERIFICATION` | `required` (the default): the workspace is inert until the emailed link proves the address. |
   | `LEGAL_*` | the waitlist identity from the preconditions table; leave the business-only fields unset. |

   The Cloud topology also needs its documented boot/gate configuration —
   `METRICS_TOKEN`, `TRUST_PROXY_DEPTH`, backup settings, `VAULT_ENCRYPTION_KEY`,
   `NOTIFIER_WEBHOOK_URL` and `EXTERNAL_PROBE_URL` — in
   [first-apply.md](../deployment/first-apply.md). None of them enables paid
   mode.
4. **Prove the application topology before credentials exist:**

   ```bash
   npm run launch:rehearse
   ```

   Docker is required. The rehearsal builds the production-parity stack, runs
   the launch gate against it with a fixture environment, writes evidence and
   tears the stack down. It does not prove Hetzner, DNS, Let's Encrypt or B2
   ([evidence-index.md](../security/evidence-index.md)).
5. **Apply the Cloud topology** following [first-apply.md](../deployment/first-apply.md).
   The real commands, from `deploy/terraform`, are:

   ```bash
   cp backend.hcl.example backend.hcl
   cp terraform.tfvars.example terraform.tfvars
   terraform init -backend-config=backend.hcl
   terraform plan -out=staging.tfplan
   terraform apply staging.tfplan
   ```

   Then confirm the A record, the TLS certificate and the first health check
   (`curl -fsS https://app.<your-domain>/api/health`) as described in that
   runbook. Use a released image tag that exists in the registry.
6. **Close the Cloud-topology gaps** from
   [launch-checklist.md](launch-checklist.md) and
   [first-apply.md](../deployment/first-apply.md):
   - put a real webhook in `deploy/prometheus/alertmanager.yml` (or let the
     Terraform module substitute it) and send a test alert;
   - configure the external availability probe from
     [external-monitoring.md](../operations/external-monitoring.md) and
     [`deploy/monitoring/uptime-probe.yml`](../../deploy/monitoring/uptime-probe.yml),
     then point `EXTERNAL_PROBE_URL` at the same URL;
   - run the real restore drill against the backup target with
     `node scripts/restore-drill.mjs --pg-restore`, recording recovery time and
     row counts ([rto-rpo.md](../operations/rto-rpo.md)).

   These are Cloud-topology checks, not the fiscal position or the security
   audit.
7. **Run the mechanical gates.** Scripts are defined in
   [`package.json`](../../package.json):

   ```bash
   npm run gate
   npm run gate:docker
   npm run launch:check -- --cloud --url <url> --evidence .acceptance/<version>
   ```

   Run `launch:check` where the environment is defined, and **do not add
   `--paid`**: that profile requires the audit and the fiscal position, which
   belong to the later paid launch. The live `--url` probe covers the public
   origin, TLS, headers, legal pages, canonical HTML/JSON parity, the
   trademark canary and the data-rights endpoints
   ([launch-checklist.md](launch-checklist.md)).
8. **Run the Cloud acceptance suite** (needs Docker; it is not part of the
   merge gate):

   ```bash
   npm run acceptance:cloud
   ```

   Its scope and boundaries are in [cloud-acceptance.md](cloud-acceptance.md).
9. **Install the PWA on a phone at the canonical origin.** Confirm the manifest
   and the app shell load, accept a browser push opt-in and tap a notification
   through to its decision screen. Native push is not part of Phase A
   ([ADR-0116](../adr/0116-mobile-device-sessions-and-push.md)).
10. **Record the evidence** in the table below, open the waitlist to design
    partners and watch the activation funnel. Stop at the activation gate:
    store submission is Phase C.

## Activation gate before any store work

Targets are those of [founding-cohort.md](founding-cohort.md):

| Funnel step / metric | Target |
|---|---|
| signup → verified | ≥70% |
| verified → first score | ≥60% |
| first score → portfolio import | ≥40% |
| design partners with a real keep/drop decision | 20 |
| free → paid | 2–5% |
| churn | <5%/month |
| first response to a design partner | <1 business day |

[ADR-0117](../adr/0117-mobile-release-sequence.md) Phase B opens only when the
verified→first score and first score→import targets are met **and** at least
20 design partners have made a real keep/drop decision. The signup→verified
and response-time targets are measured on the same funnel. Free→paid and churn
cannot be observed while `CLOUD_PAID_ENABLED=false`: record the
willingness-to-pay answers from the interviews and treat those two figures as
targets for the later paid cohort, not as a Phase A exit condition. A store
cannot create demand the web product has not already demonstrated.

## What the PWA deliberately does not do

- **No prices, checkout, upgrade button or in-app purchase.** The app shows the
  plan as a fact and leaves account management on the web
  ([ADR-0114](../adr/0114-mobile-first-pwa-and-capacitor-shell.md),
  [ADR-0117](../adr/0117-mobile-release-sequence.md)). The mobile value
  contract is the decision method, not a predicted price
  ([ADR-0115](../adr/0115-mobile-value-contract-method-not-estimate.md)).
- **No native push.** Browser push with VAPID works where the platform supports
  it; FCM/APNs delivery, secure token storage and biometrics are follow-up
  work with vendor credentials ([ADR-0116](../adr/0116-mobile-device-sessions-and-push.md),
  [mobile-release.md](mobile-release.md)).
- **No i18n.** The interface and the published documents are English only;
  there is no locale switch or translated bundle in Phase A
  ([ADR-0114](../adr/0114-mobile-first-pwa-and-capacitor-shell.md),
  [legal-surface.md](../legal/legal-surface.md)).
- **No offline data cache.** The service worker caches the app shell and hashed
  static assets; `/api/` responses are never cached, so scores and portfolios
  always come from the server ([`frontend/public/sw.js`](../../frontend/public/sw.js),
  [ADR-0114](../adr/0114-mobile-first-pwa-and-capacitor-shell.md)).
- **No store artifacts.** No Capacitor projects, no store accounts and no
  submissions are part of Phase A ([mobile-release.md](mobile-release.md),
  [ADR-0117](../adr/0117-mobile-release-sequence.md)).

## Evidence to record

The columns follow [evidence-index.md](../security/evidence-index.md): a claim
without the command that produced it is a screenshot, not evidence.

| Command | Artifact | Where |
|---|---|---|
| `npm run gate` | exit code and CI log | Woodpecker or `ci-local` (public) |
| `npm run gate:docker` | exit code | `ci-local` or Woodpecker (public) |
| `npm run launch:rehearse` | `rehearsal-*.json` / `.md` and `.acceptance/report.json` | `.acceptance/launch/` (git-ignored) |
| `npm run launch:check -- --cloud --url <url> --evidence .acceptance/<version>` | `launch-evidence-*.json` / `.md` | `.acceptance/<version>/` (git-ignored) |
| `npm run acceptance:cloud` | `.acceptance/report.json` | `.acceptance/` (git-ignored) |
| the external probe (`EXTERNAL_PROBE_URL`) | uptime history | the probe vendor (private) |
| the Alertmanager test alert (`curl`) | timestamp and acknowledgement of the message | operations log (private) |
| `node scripts/restore-drill.mjs --pg-restore` | command output: recovery time, replay stop point and row counts | operations log (private) |
| `GET /public/legal` | the live response | the deployment (public) |
| the operator overview of the `events` table | the signup → verified → first score → import funnel | operator overview and operations log (private) |

Before attaching anything to a release, apply the redaction review in
[evidence-index.md](../security/evidence-index.md).

## References

- Decisions:
  [ADR-0100](../adr/0100-launch-gate-profiles-and-evidence.md),
  [ADR-0107](../adr/0107-trust-boundary-of-a-paying-tenant.md),
  [ADR-0108](../adr/0108-waitlist-not-a-shop.md),
  [ADR-0112](../adr/0112-the-first-real-customer.md),
  [ADR-0114](../adr/0114-mobile-first-pwa-and-capacitor-shell.md),
  [ADR-0115](../adr/0115-mobile-value-contract-method-not-estimate.md),
  [ADR-0116](../adr/0116-mobile-device-sessions-and-push.md),
  [ADR-0117](../adr/0117-mobile-release-sequence.md),
  [ADR-0118](../adr/0118-operator-identity-sole-trader.md).
- Runbooks and launch plans:
  [mobile-release.md](mobile-release.md),
  [founding-cohort.md](founding-cohort.md),
  [launch-checklist.md](launch-checklist.md),
  [cloud-launch-readiness.md](cloud-launch-readiness.md),
  [soft-launch-community.md](soft-launch-community.md),
  [cloud-acceptance.md](cloud-acceptance.md),
  [first-apply.md](../deployment/first-apply.md).
- Legal, operations and evidence:
  [legal-surface.md](../legal/legal-surface.md),
  [audit-scope.md](../security/audit-scope.md),
  [evidence-index.md](../security/evidence-index.md),
  [external-monitoring.md](../operations/external-monitoring.md),
  [rto-rpo.md](../operations/rto-rpo.md),
  [secrets.md](../operations/secrets.md).
- Source of truth for commands and configuration:
  [`.env.example`](../../.env.example),
  [`src/config.ts`](../../src/config.ts),
  [`package.json`](../../package.json),
  [`scripts/generate-vapid-keys.mjs`](../../scripts/generate-vapid-keys.mjs),
  [`frontend/public/sw.js`](../../frontend/public/sw.js).
