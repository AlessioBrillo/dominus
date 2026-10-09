# Service Level Agreement (DOMINUS Cloud, Enterprise)

> **Status: DRAFT.** The technical facts below are what the platform provides
> today. The figures marked **(proposed)** are commercial commitments that need
> the owner's approval before they are quoted in any contract or order form.

Applies to: DOMINUS Cloud Enterprise customers, as referenced from the order
form (see [COMMERCIAL_LICENSE.md](../../COMMERCIAL_LICENSE.md)). The Community
edition is self-hosted and carries no SLA.

## 1. What is measured

| Item                 | Definition                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Availability         | share of minutes in a calendar month in which `GET /api/health` answers 200 from an external probe                                                                           |
| Excluded downtime    | announced maintenance, customer-caused outages, upstream outages of DNS roots, RDAP/WHOIS registries, USPTO/EUIPO, Stripe or the customer's identity provider, force majeure |
| Data-source verdicts | A domain is never reported as available when its DNS/RDAP evidence is unavailable; degraded sources reduce results, not correctness (ADR-0002)                               |

## 2. Service levels

| Objective            | Target                                                                   | Basis                                       |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| Monthly availability | **99.5 % (proposed)**                                                    | single application node, no standby replica |
| Recovery point (RPO) | <= 24 h; <= 5 min with WAL shipping to object storage                    | [RTO/RPO](rto-rpo.md) (documented)          |
| Recovery time (RTO)  | 30-60 min typical; up to 4 h if the node must be replaced                | [RTO/RPO](rto-rpo.md) (documented)          |
| Planned maintenance  | announced >= 48 h ahead, outside 06:00-22:00 CET weekdays **(proposed)** |                                             |

The platform is a single-node deployment. 99.5 % allows roughly 3.6 hours of
downtime per month; a higher figure would need a standby node, which is
available as a dedicated-infrastructure option (section 5).

## 3. Support

| Severity | Meaning                                   | First response (proposed) |
| -------- | ----------------------------------------- | ------------------------- |
| 1        | service down or data at risk              | 4 business hours          |
| 2        | major feature unusable, workaround exists | 1 business day            |
| 3        | minor issue or question                   | 2 business days           |

Business hours: Monday-Friday 09:00-18:00 CET, excluding Italian public
holidays. Channel: the support address in the order form **(to be defined)**.
Security reports follow [SECURITY.md](../../SECURITY.md) instead.

## 4. Service credits

Credits for availability below target are **to be defined in the order form**
(proposed shape: a percentage of the monthly fee per availability band, capped,
claimed within 30 days, as the sole remedy for downtime).

## 5. Dedicated infrastructure

Customers who need a higher availability objective, data residency or network
isolation can be given their own application and database nodes, provisioned
with the Terraform modules in `deploy/terraform/` (`app-node`, `db-node`). This
is an engagement, priced separately, not a self-service plan.

## 6. How it is monitored

- Prometheus, Alertmanager and Grafana run in the production profile
  (`docker-compose.prod.yml`): API down, provider error rate, stage errors,
  stuck queue and dead-letter alerts.
- `pitr_health` verifies the base-backup manifest and raises an alert when it
  goes stale ([RTO/RPO](rto-rpo.md)).
- An **external** availability probe is needed to measure section 1 honestly; it
  is not part of the repository and must be set up by the operator before an SLA
  is offered.

## 7. Open decisions before this is final

1. Availability target and credit schedule (sections 2 and 4).
2. Support address, hours and response times (section 3).
3. Who operates the external probe and publishes monthly availability.
