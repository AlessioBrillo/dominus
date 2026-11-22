# Transfer register (GDPR chapter V)

**Status: template for the operator.** The Privacy Notice states the
mechanism in general terms. This register records the per-recipient facts a
business customer is entitled to ask for: country, transfer mechanism and the
date of the transfer impact assessment.

| Recipient | Purpose | Country | Mechanism | TIA date |
|---|---|---|---|---|
| Hetzner Online GmbH | application and database hosting | Germany | no transfer outside the EEA | n/a |
| Stripe Payments Europe Ltd. | billing and tax | Ireland | no transfer outside the EEA for the payment account; SCCs for US support access | `[date]` |
| Backblaze Inc. | off-host backups, when enabled | United States | EU-US Data Privacy Framework if certified, otherwise SCCs + supplementary measures | `[date]` |
| Okta, Inc. / Auth0 | SSO, for tenants that use it | United States | EU-US Data Privacy Framework if certified, otherwise SCCs + supplementary measures | `[date]` |
| `[SMTP provider]` | transactional email | `[country]` | `[DPF or SCCs, or "no third country" for self-hosted SMTP]` | `[date]` |

## What to record

For each recipient outside the EEA, keep:

- the linked DPF certification or the signed SCCs, with the module and the
  parties identified;
- the supplementary measures actually in place (encryption in transit and at
  rest, key custody, access restrictions);
- the transfer impact assessment, dated and signed by the reviewer;
- the date the sub-processor list was last published and the date any customer
  objection was answered.

A sub-processor added without a row in this table is a launch blocker. The
operator must publish the updated list and give customers the contractual
notice period before the new processor receives personal data.
