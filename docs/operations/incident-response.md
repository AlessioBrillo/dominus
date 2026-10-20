# Incident response

DOMINUS Cloud runs multi-tenant production data. When something breaks, the
difference between a ten-minute and a two-hour incident is usually whether
the responder can answer three questions immediately: when did it start, what
is affected, and which request do I look at.

This runbook is the answer to "what do I do now". It is intentionally short.
A long runbook is not read during an incident.

## Before anything else: find the request

Every response carries an `X-Request-Id` header and every error body carries
`requestId` (v1.2.0). They are the same value, and every log line emitted
while that request was in flight carries it, because a pino mixin reads it
from the AsyncLocalStorage the request context created.

```bash
# Everything that happened for one reported failure
grep '"requestId":"<id-from-the-ticket>"' /var/log/dominus/*.log
```

If a customer reports "the score page is down", ask for the id in the
response, not a screenshot. When there is no id (a page that never loaded),
fall back to the time window.

## Severity ladder

| Severity | Definition | Examples | Response |
|---|---|---|---|
| **SEV-1** | Data loss, cross-tenant leak, or money wrong | A tenant sees another tenant's domains; a Stripe charge is applied twice; a backup restore fails | All hands, immediately. Freeze the deploy. No fixes under pressure — restore. |
| **SEV-2** | The service is down or unusable for some tenants | API 5xx; the worker stops dequeuing; DNS consensus is degraded for everyone | Respond now. Post visible status within 15 min. |
| **SEV-3** | Degraded but working | One provider leg failing; slow runs; single tenant cannot sign in | Respond within the SLA window. |
| **SEV-4** | Cosmetic or cosmetic-plus | Chart label, broken link, a font | Normal queue. |

The only severity worth arguing about is SEV-1, and the rule is simple:
**if a tenant's data may be wrong, exposed or unrecoverably gone, it is
SEV-1** regardless of how healthy the dashboards look. A green
`/api/health` does not mean a tenant is isolated.

## First 5 minutes

1. **Stop the bleeding, not the cause.** Roll back before you diagnose.
   The deploy pipeline migrates before it rolls (ADR-0061), so a rollback
   does not undo schema changes; if a migration is implicated, go to the
   recovery runbook in [RTO/RPO](rto-rpo.md) instead.
2. **Read `/api/health`.** It reports DNS provider health, quorum state and
   whether consensus is degraded. DNS degradation is the most common cause
   of "verdicts changed without us deploying anything".
3. **Read Grafana** (`deploy/grafana/`): API error rate, stage errors, stuck
   queue, dead letters, provider error rate. Alertmanager routes these; the
   rules live in `deploy/prometheus/rules.yml`.
4. **Check the queue.** A stuck `job_queue` looks identical to an outage
   because runs never complete. Dead letters are the place to look.
5. **Write down the timeline as you go.** Every action with a timestamp.
   Reconstructing it afterwards from logs is what turns a 30-minute incident
   into a 3-hour one.

## DNS consensus incidents

A large share of "it stopped reporting domains as available" reports are the
consensus gate working correctly (ADR-0039, ADR-0002). Before escalating:

- A run marked `degraded` is a partial answer, and the CLI exits non-zero
  on purpose. This is the intended fail-closed signal, not a bug.
- If the consensus provider is misconfigured the system is meant to fail
  fast at startup rather than serve unverifiable verdicts.
- A verdict downgraded to `Unknown` means a resolver leg could not be
  verified. That is correct behaviour.

Do not "fix" this by loosening consensus thresholds during an incident.

## Escalation

1. The on-call engineer named in the rotation.
2. The platform owner (maintainer of `deploy/`).
3. For billing anomalies, the Stripe owner — check the Stripe dashboard
   against `job_queue` dead letters before assuming our side is wrong.

External escalation is only required for SEV-1. For a cross-tenant leak or a
payment error, GDPR notification obligations start running immediately:
involve the platform owner at once, not at the end of the incident.

## The status page

The severity ladder promises a visible status for SEV-2 within fifteen
minutes, and a status nobody can read is not a status. The status page is
the operator's own hosted page (a hosted provider, not the app node: the
app node is the thing that breaks) and it is linked from the public site
and from the incident emails.

What it has to carry, in this order:

| Field | Why it is there |
|---|---|
| Current state | `operational`, `degraded`, `partial outage`, `major outage` |
| What is affected | the API, the pipeline runs, the dashboard, the automation |
| Start time | the question every customer asks first |
| The last update | a status that stops being updated is worse than none |
| The incident reference | the post-mortem link, when it exists |

Two rules that the severity ladder depends on:

- **Update it on a schedule even when nothing changed.** A customer who
  checks the page every five minutes and sees a timestamp that moved knows
  somebody is awake.
- **Do not post a cause before it is known.** "Under investigation" is a
  status; a guess is not.

The external probe ([external-monitoring.md](external-monitoring.md)) is
the source for the current state: it measures the same thing the status
page claims, so the two cannot drift apart silently.

## After it is over

Within 48 hours, a post-mortem with:

- Timeline, from first signal to resolution.
- Impact, stated in tenants affected and duration.
- Root cause, distinguished from trigger — "the migration was slow" is a
  trigger, "no timeout on the migration step" is a cause.
- What we will change, each with an owner and an issue number. A
  post-mortem without a dated action item is a record, not a process.

Post-mortems are blameless. A responder who broke production is not the
finding; the fact that it was possible is.

## What this document deliberately does not cover

- The recovery runbook for data loss, which lives in
  [RTO/RPO](rto-rpo.md) because it has different tools and different owners.
- The routine operations commands (`dominus maintenance backup`, `vacuum`,
  `prune`), documented in [ADR-0022](../adr/0022-backup-and-operations.md).
- Specific alert thresholds, which live in
  `deploy/prometheus/rules.yml` so that changing them is a reviewed change
  rather than a documentation edit.
