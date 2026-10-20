# Billing tax verification — Stripe Tax, EU VAT and the reverse charge

**Status:** implemented, **not yet verified against a live Stripe account**.
This document is the runbook for that verification and the place where its
evidence is recorded. It is one of the items the launch gate checks.

## What the code does now

`src/services/billing-service.ts` creates the Checkout session with four
parameters that were missing, and one that was already there:

| Parameter | Value | Why |
|---|---|---|
| `automatic_tax` | `{ enabled: true }` | Stripe Tax determines the rate from the customer's location. |
| `billing_address_collection` | `'required'` | Stripe Tax cannot determine a rate without an address; without it the calculation silently falls back. |
| `tax_id_collection` | `{ enabled: true }` | Lets an EU business enter its VAT ID. Stripe validates it against VIES, and a valid ID moves the invoice to the reverse charge mechanism. |
| `customer_update` | `{ address: 'auto', name: 'auto' }` | Only sent when the tenant already has a Stripe customer: Checkout writes the collected address back, which Stripe requires when automatic tax is used with an existing customer. |
| `consent_collection` + `custom_text` | `terms_of_service: 'required'` + the art. 59(1)(o) acknowledgement | The express consent and the acknowledgement that make the 14-day withdrawal right lapse for a digital service supplied immediately. |

The withdrawal text lives in `CHECKOUT_TERMS_CONSENT_MESSAGE`
(`src/services/billing-service.ts`) and is asserted by the test suite, so the
consent and its acknowledgement cannot drift apart.

## What only the operator can configure

These are Stripe dashboard settings; no code can set them:

1. **Tax registrations.** In the Stripe dashboard, under *Settings → Tax
   settings → Tax registrations*, add the Italian registration (and the EU
   OSS registration if B2C sales outside Italy are expected to exceed
   €10,000/year). Without a registration for the customer's country, Stripe
   Tax does not apply the local rate.
2. **Price tax behaviour.** Every price must be **tax-exclusive** ("Standard
   pricing" with `tax_behavior: 'exclusive'`), because the published prices
   exclude VAT (see the legal notice, "Prices, taxes and billing").
3. **Terms of service URL.** The consent checkbox links to the terms URL
   configured on the Stripe account. It must point at
   `https://<deployment>/terms`, otherwise the consent collected at checkout
   refers to a different document than the one published in the application.
4. **Invoice settings.** Add the Italian VAT ID to the invoice settings, so
   the invoices carry it.

## The three scenarios to verify

Run them with a Stripe **test** account and test-mode prices, then repeat
against the live account before the launch. For each scenario, record the
checkout session id, the computed tax, and the invoice.

### 1. Italian consumer (B2C)

- Checkout: no VAT ID entered, billing address in Italy.
- Expected: Italian VAT added at the standard rate on top of the price; the
  invoice shows the VAT rate and amount.

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
- the choice of the tax regime for the operator (forfettario, ordinary) and
  its consequences for the prices published;
- the data processing agreement (GDPR art. 28) with Stripe, Auth0, the
  backup provider and the SMTP provider.

These are commercial tasks with an accountant, not engineering work. They are
tracked in `docs/releases/cloud-launch-readiness.md`.
