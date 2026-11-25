# Transactional email - the transport the product cannot boot without

Status: **required before the Cloud launch**. In `required` mode (the
default) the signup refuses to create a workspace when `SMTP_URL` is unset:
a workspace whose verification link can never be delivered is a workspace
nobody can use. Passwordless sign-in and billing lifecycle mail depend on
the same transport.

## Provider choice

| Criterion | Requirement |
| --------- | ----------- |
| Data residency | EU processor with a DPA; keep the mailbox out of third-country transfers where possible |
| Throughput | Brevo free tier (300 messages/day) is enough for the launch topology; scale before the founding cohort fills up |
| Authentication | SPF, DKIM and DMARC on the sending subdomain; a hard-failing DMARC is not optional for login links |
| Bounce handling | A hard bounce marks the address unverified; a magic link sent to a dead mailbox must not stay claimable |
| Separation | `mail.<your-domain>` for transactional mail; never send billing from the same address used for community support |

Recommended at launch: **Brevo** or **Scaleway TEM** (both EU). Amazon SES in
an EU region and Postmark are acceptable if the DPA and transfer documentation
are in place. Avoid a personal mailbox: deliverability of authentication mail
is the product.

## Configuration

Set in the deployment environment, not in tracked files:

```
SMTP_URL=smtps://<user>:<password>@smtp.<provider>:465
SMTP_FROM=DOMINUS <no-reply@mail.<domain>>
PUBLIC_APP_URL=https://<canonical-origin>
LEGAL_CONTACT_EMAIL=<support inbox>
LEGAL_PRIVACY_EMAIL=<data-rights inbox>
```

The canonical origin must match the deployment or the verification and magic
links point at the wrong host. `launch:check --paid` probes that parity.

## Verification before launch

1. Send a real signup and open the link from a different mailbox provider.
2. Send a magic link and confirm it is single-use and expires.
3. Trigger a failed payment and confirm the dunning email arrives (ADR-0112).
4. Check the received headers: `spf=pass`, `dkim=pass`, `dmarc=pass`.
5. Confirm a hard bounce marks the address unverified and revokes keys issued
   before the proof.

Evidence belongs in `.acceptance/launch/`, written by `npm run launch:check
-- --cloud --url ... --paid --evidence .acceptance/launch`.
