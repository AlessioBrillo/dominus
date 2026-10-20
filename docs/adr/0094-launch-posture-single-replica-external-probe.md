# ADR-0094: One replica, one external probe: the launch posture is measured, not promised

## Metadata

| Field          | Value                                                     |
| -------------- | --------------------------------------------------------- |
| **Status**     | Accepted                                                  |
| **Date**       | 2026-10-20                                                |
| **Authors**    | Alessio Brillo                                            |
| **Deciders**   | Alessio Brillo                                            |
| **Supersedes** | —                                                         |
| **Relates to** | ADR-0026, ADR-0033, ADR-0054, ADR-0061, ADR-0090         |
| **Project**    | DOMINUS                                                   |

## Context

The Cloud offering is a two-node deployment: an app node (API, worker,
scheduler, Redis, Unbound, Prometheus, Alertmanager, Grafana, Caddy) and a
database node (PostgreSQL 17 with PITR). The SLA commits to 99.5% monthly
availability, measured "by an external probe, configured per deployment",
and states plainly that there is no standby replica: recovery after a node
loss is a restore, not a failover.

Three things about that posture were decided but never implemented:

1. **The monitor could not report the outage.** Prometheus, Alertmanager and
   Grafana run on the app node. An app-node outage takes the alerting with
   it, so the event that matters most is the one nothing reports. The
   availability figure in the SLA had no instrument.
2. **The infrastructure had never been applied.** The Terraform exists, the
   CI validates it, and no `terraform apply` had ever been observed. The
   restore drill was a static inspection of a base-backup directory: it
   proved the file layout and not the data, so the RTO in
   `docs/operations/rto-rpo.md` was a target and not a measurement.
3. **The ingress was open by default.** `ssh_allowed_cidrs` defaulted to
   `0.0.0.0/0` on both nodes — key-only SSH with fail2ban, from any
   address — because the default existed to "preserve existing
   deployments". A default that is safe for the incumbent and unsafe for a
   public launch is a default that has to be decided, not inherited.

## Decision Drivers

1. **A commitment nobody measures is a marketing sentence.** The SLA is
   honest about the limits; it must also be honest about the instrument.
2. **The first launch has to be rehearsable.** A deployment that has never
   been applied cannot be rolled back, and a restore that has never been
   performed cannot be promised.
3. **One replica, stated plainly, beats two replicas that lie.** The
   in-process rate limiter counts per replica; a second API replica without
   a shared store makes the effective limit `RATE_LIMIT_MAX × replicas` and
   resets a per-token counter when the balancer moves a caller.
4. **Safe defaults must fail closed.** The operator has to write the
   dangerous decision down, not inherit it from a previous deployment.

## Considered Options

### Option A: Two API replicas behind Caddy, for zero-downtime rollouts

**Advantages:** no maintenance window; a single container crash is not an
outage.

**Disadvantages:** the protected rate limiter becomes wrong (ADR-0033, ADR
0041/0052 note the shared store comes with the multi-replica topology); the
SLA would have to be rewritten; the operational surface doubles on the one
node that everything else already sits on.

### Option B: One replica, plus a second node for the proxy

**Advantages:** the proxy survives an app-node failure.

**Disadvantages:** a proxy that cannot reach the app node is not
availability; it is a second thing to patch, for a topology that the
Terraform deliberately keeps on one node.

### Option C: One replica, an external probe, and a rehearsed restore

**Advantages:** every promise in the SLA becomes measurable; the failure
modes are the ones the architecture has; the operator's remaining work is
operational (apply the Terraform, run the drill) rather than architectural.

**Disadvantages:** a rollout has a short window in which the API is
restarted; a node loss is still a restore.

## Decision

**Option C.**

- **One application replica, stated in the SLA and in the launch
  checklist.** The rollout's restart is a maintenance window outside
  business hours, as the SLA already allows.
- **An external availability probe** (`deploy/monitoring/uptime-probe.yml`,
  `docs/operations/external-monitoring.md`): a monitor outside the app
  node, pointed at `/api/health`, with a dead-man's switch for the opposite
  condition. The probe must not depend on an upstream service: a degraded
  provider reduces the number of verdicts, not the availability figure.
  `EXTERNAL_PROBE_URL` is read by the launch gate, which warns without it
  and fails with `--paid`.
- **A real restore rehearsal.** `scripts/restore-drill.mjs --pg-restore`
  restores a base backup, replays the WAL, waits for the recovery to
  finish, proves it is talking to the restored instance and compares row
  counts. The static `--pg-base` inspection stays, and is documented as
  what it is: a layout check.
- **Fail-closed ingress.** The Terraform's `ssh_allowed_cidrs` defaults to
  empty and the apply is refused until the operator either lists their own
  CIDRs or sets the explicit `allow_public_ssh = true`. The state moves to
  remote storage (Backblaze B2, S3-compatible) because it holds the
  database passwords, the B2 key and the whole `app_env` map: it is a
  secret store, and a secret store does not live on a laptop.

## Consequences

### Positive

- The availability figure in the SLA is measured by something that does not
  live on the node that fails.
- The RTO is a rehearsed number: the drill restores, replays and compares
  rows, and it can fail.
- The dangerous ingress decision is written down at apply time.
- The remote state survives the loss of the machine that created it.

### Negative

- A rollout has a maintenance window. The SLA already announces one, and
  the SLA does not promise zero downtime.
- The operator has to configure a monitor and keep the heartbeat alive.
  This is work that no amount of automation removes: somebody has to answer
  the alert.
- The `ssh_allowed_cidrs` change refuses an apply for an existing
  deployment that never set it. That is the point: the decision becomes
  explicit, and the firewall is updated in place, without recreating a
  node.

## Links

- `deploy/monitoring/uptime-probe.yml` — the probe specification.
- `docs/operations/external-monitoring.md` — how to configure it.
- `docs/operations/rto-rpo.md` — the recovery objectives and the drill.
- `scripts/restore-drill.mjs` — the rehearsal.
- `deploy/terraform/main.tf` — the fail-closed ingress and the state.
- `docs/operations/sla.md` — the commitment being measured.
