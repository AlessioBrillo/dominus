# Data-subject request runbook

The self-service export and erasure are documented in
[data-rights.md](data-rights.md). This runbook covers the requests that cannot
be answered by those two endpoints: rectification, restriction, objection,
withdrawal of consent, and questions about a public score or an offer enquiry.

## 1. Acknowledge

Acknowledge receipt within **3 working days**. Record the request id, the date,
the channel and the requester's contact in the request log. Do not ask for more
identity evidence than is necessary: where the request comes from the account
email, that is usually enough.

## 2. Identify and scope

- **Account holder**: resolve the account to a tenant. A tenant can contain
  other people's data (team members); the requester may exercise rights only
  over their own personal data, not over the workspace as a whole.
- **Waitlist subscriber**: look for the address in the waitlist store. Withdrawal
  of consent is always effective going forward and is not retroactive.
- **Offer sender**: the enquiry belongs to the seller's tenant; identify both
  the sender and the seller before acting.
- **Public score**: no personal data is published about the owner. If the owner
  asks for removal, unpublish the page.

## 3. Act within one month

The GDPR deadline is **one month** from receipt. Extend by two further months
only for complex requests, and tell the requester about the extension and the
reason within the first month.

| Right | Action |
|---|---|
| Access / portability | `GET /api/v1/tenant/export` ( tenant scope) or the equivalent extract for a non-account requester |
| Rectification | correct the source record, not a copy; note the old value in the request log |
| Erasure | `DELETE /api/v1/tenant` with the typed confirmation, or remove the specific record |
| Restriction / objection | record the restriction on the record and stop the processing; do not delete it |
| Withdrawal of consent | remove the waitlist entry and stop the sending; record the withdrawal date |

Backups and records kept by law are the declared limits; explain them in the
reply rather than silently leaving data in place.

## 4. Reply and close

Reply in writing with what was done, what was not done and why, and the date of
the reply. If a supervisory authority complaint is pending, copy the authority
where the law requires it. Close the request log entry with the outcome and the
number of days elapsed.

## 5. Escalation

If the request cannot be answered with the tools above, or if it arrives from a
supervisory authority, stop and contact the operator before acting. Do not
delete data on the basis of an unverified request.
