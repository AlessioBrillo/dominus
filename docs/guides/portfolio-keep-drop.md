# Portfolio: keep, drop or reprice

A domain that does not sell is a recurring liability. Every portfolio domain
answers one question: **keep, drop or reprice**.

## The renewal clock

Each entry stores `acquiredAt`, `renewalDate`, `acquisitionCost`, `renewalCost`,
its current score and a verdict. The **Portfolio** page shows them with the days
left; **Dashboard** shows active renewal alerts.

```bash
dominus portfolio list             # domains with renewal status
dominus portfolio update-costs <domain> --renewal-cost 12.5
```

## Verdicts

```bash
dominus portfolio rescore          # rescore every domain with current signals
dominus portfolio verdicts         # refresh keep / drop / reprice
```

The verdict follows two knobs (see `.env.example`):

- `DROP_SCORE_THRESHOLD` — below this score a domain is a drop candidate.
- `DROP_RENEWAL_HORIZON_DAYS` — how far ahead a renewal counts as "coming up".

The scheduler rescores the portfolio weekly (`SCHEDULER_RESCORE_CRON`, Mondays
09:00 by default), checks renewals daily (`SCHEDULER_RENEWAL_CHECK_CRON`) and
verifies renewal dates with RDAP/WHOIS weekly
(`SCHEDULER_PORTFOLIO_HEALTHCHECK_CRON`); run the commands above to do it on
demand. You can override a verdict on the Portfolio page.

## Renewal alerts

```bash
dominus portfolio alerts list --unacknowledged
dominus portfolio alerts acknowledge --id 12     # or --domain example.com / --all
dominus portfolio alerts run                     # check now
```

Alerts reach the console and, if configured, desktop, webhook, Telegram or
**email** (`SMTP_URL` + `NOTIFIER_EMAIL_TO`). On the Dashboard you can dismiss
one alert or all of them.

## Close the loop: outcomes and weights

Record what actually happened so the engine can learn from it:

```bash
dominus outcome record ...        # sold, expired, dropped, ...
dominus outcome stats
```

Then open **Backtest**: it compares predictions with outcomes and suggests
weight changes. Review them before applying. The score engine stays
conservative by design; a weight change must be justified by real sales.

## What the API and CLI cover beyond the UI

These are available from the API/CLI only: acquisition funnel (`/funnel`),
reports (`/report`, `/report/tld`, `/report/risk`, `/report/roi`), usage limits
(`/usage/limits`), manual scheduler runs (`/scheduler/run/:job`) and worker
status (`/system/worker`). See the OpenAPI document at `/api/v1/docs`.
