# Billing tax verification — Stripe Tax, EU VAT and the reverse charge

**Status:** implemented in code, **not yet verified against a live Stripe
account**. This document is the runbook for that verification and the place
where its evidence is recorded. It is one of the items the launch gate checks.

While `CLOUD_PAID_ENABLED=false` the hosted edition is a waitlist, **no price
is published**, and none of the scenarios below can be exercised by a
customer. This runbook describes what will be true when paid mode is opened,
not a shop that is already trading. See ADR-0108.

## What the code does now

`src/services/billing-service.ts` creates the Checkout session with the
parameters that make an EU subscription taxable correctly:

| Parameter | Value | Why |
|---|---|---|
| `automatic_tax` | `{ enabled: true }` | Stripe Tax determines the rate from the customer's location. |
| `billing_address_collection` | `'required'` | Stripe Tax cannot determine a rate without an address; without it the calculation silently falls back. |
| `tax_id_collection` | `{ enabled: true }` | Lets an EU business enter its VAT ID. Stripe validates it against VIES, and a valid ID moves the invoice to the reverse charge mechanism. |
| `customer_update` | `{ address: 'auto', name: 'auto' }` | Only sent when the tenant already has a Stripe customer: Checkout writes the collected address back, which Stripe requires when automatic tax is used with an existing customer. |
| `subscription_data.trial_period_days` | `14`, first checkout only | A plan change must not re-grant the trial; once a Stripe customer exists, new subscriptions start on a paid cycle. |
| `consent_collection` + `custom_text` | `terms_of_service: 'required'` + the contract acceptance message | The customer accepts the current terms and asks for immediate performance. |

The consumer **keeps** the 14-day withdrawal right and, when performance
starts at their request, pays only for the part of the service supplied
(art. 57(3) of the Italian Consumer Code). The operator does **not** rely on
the art. 59(1)(o) waiver for a digital service supplied immediately: it is
doubtful for a service supplied over time, and asking for it would misdescribe
the operator's own policy. The acceptance message lives in
`CHECKOUT_TERMS_CONSENT_MESSAGE` (`src/services/billing-service.ts`) and is
asserted by the test suite, so the consent and its wording cannot drift apart.
See ADR-0108 and ADR-0109.

## What only the operator can configure

These are Stripe dashboard settings; no code can set them:

1. **Tax registrations.** In the Stripe dashboard, under *Settings → Tax
   settings → Tax registrations*, add the Italian registration (and the EU
   OSS registration if B2C sales outside Italy are expected to exceed the
   threshold). Without a registration for the customer's country, Stripe Tax
   does not apply the local rate.
2. **Price tax behaviour.** Prices must be created with
   `tax_behavior: 'inclusive'` to match the decision that **the published
   price is the price the customer pays, VAT included**, with a single list
   price for consumers and businesses. Tax behaviour belongs to the Price
   object: it is fixed when the price is created and cannot be changed at
   Checkout time. A business with a validated VAT ID pays the same amount,
   with the invoice issued under the reverse charge mechanism. The rule is
   recorded in `docs/legal/legal-surface.md` ("Prices, taxes and billing");
   if that notice ever changes, the prices must be recreated to match.
3. **Terms of service URL.** The consent checkbox links to the terms URL
   configured on the Stripe account. It must point at
   `https://<deployment>/terms`, otherwise the consent collected at checkout
   refers to a different document than the one published in the application.
4. **Invoice settings.** Add the operator's VAT ID to the invoice settings,
   so the invoices carry it. The operator identity is a configuration fact
   (`LEGAL_*`), not a code change: a sole trader and a company produce the
   same code path.

## The three scenarios to verify

Run them with a Stripe **test** account and test-mode prices, then repeat
against the live account before the launch. For each scenario, record the
checkout session id, the computed tax, and the invoice.

### 1. Italian consumer (B2C)

- Checkout: no VAT ID entered, billing address in Italy.
- Expected: the price is displayed VAT-inclusive; the invoice shows the VAT
  rate and the amount already contained in the price, with nothing added at
  payment.

### 2. Italian business (B2B) with a valid VAT ID

- Checkout: billing address in Italy, a valid Italian VAT ID entered in the
  tax ID field (use a VIES-valid test number, or a real one of a colleague's
  company).
- Expected: **no Italian VAT**; the invoice is issued under the reverse
  charge mechanism and mentions it ("Inversione contabile" /
  "Reverse charge"). Stripe must report the VAT ID as *verified* — an
  unverified ID is treated as a consumer address and is taxed.

### 3. German business (B2B) with a valid VAT ID

- Checkout: billing address in Germany, a valid German VAT ID.
- Expected: no Italian VAT, invoice with the reverse charge mention. This
  scenario also proves that the OSS registration is not being applied to a
  B2B sale, which is correct: reverse charge is not an OSS supply.

## Evidence

Fill this in when the scenarios are run; the launch gate reads it.

| Scenario | Date | Session id | Tax computed | Invoice | Verdict |
|---|---|---|---|---|---|
| IT B2C | | | | | |
| IT B2B | | | | | |
| DE B2B | | | | | |

## What remains for the accountant

The code computes and collects the tax. It does not file anything:

- the **OSS return** (periodic EU B2C sales) and the domestic VAT return;
- the invoice series and the wording of the reverse-charge mention;
- the choice of tax regime for the operator (sole trader with the flat-rate
  regime, S.r.l., ordinary) and its consequences for the registered address,
  the social-security contributions and the prices published;
- the data processing agreement (GDPR art. 28) with Stripe, the identity
  provider, the backup provider and the SMTP provider.

These are commercial tasks with an accountant, not engineering work. They are
tracked in `docs/releases/cloud-launch-readiness.md` and in the operator
decision record `docs/legal/compliance-matrix.md`.
