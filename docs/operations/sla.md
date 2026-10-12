# Service Level Agreement (DOMINUS Cloud, Enterprise)

> **Status: v1.1 — effective with DOMINUS Cloud.** The commitments below are
> what the service provides and what DOMINUS undertakes to answer. They are
> deliberately conservative: the platform is a single-node deployment and
> this document does not promise more than it can deliver.

Applies to: DOMINUS Cloud Enterprise customers, as referenced from the order
form (see [COMMERCIAL_LICENSE.md](../../COMMERCIAL_LICENSE.md)). The Community
edition is self-hosted and carries no SLA.

Response times for the paid Community-facing plans (Free, Pro, Team) are in
[SUPPORT.md](../../SUPPORT.md); this document governs the Enterprise tier and
is the stricter of the two.

## 1. What is measured

| Item                 | Definition                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Availability         | share of minutes in a calendar month in which `GET /api/health` answers 200 from an external probe                                                                           |
| Excluded downtime    | announced maintenance, customer-caused outages, upstream outages of DNS roots, RDAP/WHOIS registries, USPTO/EUIPO, Stripe or the customer's identity provider, force majeure |
| Data-source verdicts | A domain is never reported as available when its DNS/RDAP evidence is unavailable; degraded sources reduce results, not correctness (ADR-0002)                               |

## 2. Service levels

| Objective            | Target                                                              | Basis                                       |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| Monthly availability | **99.5 %**                                                          | single application node, no standby replica |
| Recovery point (RPO) | <= 24 h; <= 5 min with WAL shipping to object storage               | [RTO/RPO](rto-rpo.md) (documented)          |
| Recovery time (RTO)  | 30-60 min typical; up to 4 h if the node must be replaced           | [RTO/RPO](rto-rpo.md) (documented)          |
| Planned maintenance  | announced >= 48 h ahead, outside 06:00-22:00 CET weekdays           |                                             |

99.5 % allows roughly 3.6 hours of downtime per month. A higher objective
needs a standby node, which is available as a dedicated-infrastructure
option (section 5) rather than a self-service plan. This is stated plainly
so no customer buys an expectation the architecture cannot meet.

## 3. Support

| Severity | Meaning                                   | First response |
| -------- | ----------------------------------------- | -------------- |
| 1        | service down or data at risk              | 4 business hours |
| 2        | major feature unusable, workaround exists | 1 business day   |
| 3        | minor issue or question                   | 2 business days  |

Business hours: Monday-Friday 09:00-18:00 CET, excluding Italian public
holidays. Channel: the Enterprise support address named in the order form.

Security reports follow [SECURITY.md](../../SECURITY.md) instead and are
triaged independently of the schedule above.

## 4. Service credits

Availability below 99.5 % in a calendar month earns a credit against the
next invoice:

| Monthly availability | Credit (of the monthly fee) |
| -------------------- | --------------------------- |
| < 99.5 %             | 5 %                         |
| < 99.0 %             | 10 %                        |
| < 95.0 %             | 25 %                        |

Credits are capped at 50 % of the monthly fee, must be claimed within 30
days of the end of the affected month, and are the sole and exclusive
remedy for downtime. Credits do not apply to excluded downtime (section 1)
or to customers whose own actions caused the outage.

## 5. Dedicated infrastructure

Customers who need a higher availability objective, data residency or
network isolation can be given their own application and database nodes,
provisioned with the Terraform modules in `deploy/terraform/` (`app-node`,
`db-node`). This is an engagement, priced separately, not a self-service
plan.

## 6. How it is monitored

- Prometheus, Alertmanager and Grafana run in the production profile
  (`docker-compose.prod.yml`): API down, provider error rate, stage errors,
  stuck queue and dead-letter alerts.
- `pitr_health` verifies the base-backup manifest and raises an alert when
  it goes stale ([RTO/RPO](rto-rpo.md)).
- Availability for section 1 is measured by an external probe, configured
  per deployment. The probe URL is part of the deployment's runbook and is
  not committed to this repository; the alerting rules that consume it are
  in `deploy/prometheus/`.

## 7. Honest limits

Stated so they cannot be discovered the hard way:

- There is no standby replica. Recovery after node loss is a restore, not a
  failover, and bounded by the RTO above.
- Planned maintenance inside business hours is possible for security
  fixes; the 48-hour rule applies to discretionary work.
- The upstream data sources that availability verdicts depend on (RDAP,
  WHOIS, USPTO/EUIPO, DNS roots) are outside the control of this service
  and outside the availability figure.
- An external probe failure that is caused by the probe itself is not
  downtime, but it is also not verified availability; the operator owns
  probe correctness.
