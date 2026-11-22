# Record of processing activities (GDPR art. 30)

**Status: template for the operator.** The software cannot know who installed
it or which provider delivers its mail. The operator fills this in before a
deployment is exposed to anyone other than themselves. The published Privacy
Notice describes what the software does by design; this document describes
what *this operator* does with it.

| Field | Value |
|---|---|
| Controller | `[operator legal name, address, contact]` |
| DPO | none appointed; requests go to the controller |
| Purposes | operating the website and the waitlist; providing the managed service when on sale; invoicing; security |
| Categories of data subject | website visitors, waitlist subscribers, account holders, team members, buyers making an offer |
| Categories of data | identifiers, contact data, account and authentication data, billing data, service data, offer enquiries, server logs |
| Recipients | see the [transfer register](transfer-register.md) |
| Retention | see the table in the published Privacy Notice; the operator confirms that the configured schedules match it |
| Security | TLS in transit; AES-256-GCM for provider credentials; tenant isolation in the application and, on PostgreSQL, row-level security |

## Processing activities

| Activity | Purpose | Legal basis | Data |
|---|---|---|---|
| Serving public score pages | answer a valuation request | art. 6(1)(f) | domain, estimate, request metadata |
| Waitlist | notify when the hosted edition opens | art. 6(1)(a) | email, consent version and timestamp |
| Account and team management | provide the service | art. 6(1)(b) | email, name, role, invitations |
| Billing | invoice and meet tax obligations | art. 6(1)(c) | customer id, tax id, transaction records |
| Service operation and security | keep the service available and investigate abuse | art. 6(1)(f) | IP, request id, user agent, error traces |
| Offer enquiries | pass a buyer's message to the seller | art. 6(1)(b) and (f) | name, email, message, domain |

## Review

Review this record when a sub-processor, a data category or a retention period
changes, and at least once a year. Record the date and the reviewer here:

| Date | Reviewer | Change |
|---|---|---|
| | | |
