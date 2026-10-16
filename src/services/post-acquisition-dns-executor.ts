// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PostAcquisitionStepContext,
  PostAcquisitionStepExecutor,
  PostAcquisitionStepOutcome,
} from './post-acquisition-service.js';
import type { DnsWriteGate } from './dns-write-gate.js';
import { formatDelegationInstructions } from './dns-write-gate.js';
import type { DnsGateVerdict, DnsWriteOutcome } from '../types/dns-write.js';

/**
 * `dns` step of the post-acquisition pipeline (ADR-0083, M3).
 *
 * Delegates the domain to the configured parking target through the
 * fail-closed DnsWriteGate: the decision to write is taken only after an
 * independently corroborated read of the current delegation, the write
 * itself is idempotent, and the result is confirmed from public DNS.
 *
 * Outcomes:
 *  - dry-run                                        -> skipped 'dry_run'
 *  - provider unavailable / zone not managed /
 *    delegation mismatch / unverifiable / no target -> skipped (with the
 *    manual instructions recorded, so the operator work is auditable)
 *  - already resolving to the target                -> done
 *  - applied and confirmed publicly                 -> done
 *  - applied but not confirmed                      -> failed 'write_unconfirmed'
 *    (named, resumable via `dominus automate reset <domain> dns`)
 */
export class DnsStepExecutor implements PostAcquisitionStepExecutor {
  readonly step = 'dns' as const;

  readonly #gate: DnsWriteGate;

  constructor(gate: DnsWriteGate) {
    this.#gate = gate;
  }

  async execute(ctx: PostAcquisitionStepContext): Promise<PostAcquisitionStepOutcome> {
    if (ctx.dryRun) {
      return { status: 'skipped', reason: 'dry_run' };
    }

    let verdict: DnsGateVerdict;
    try {
      verdict = await this.#gate.evaluate(ctx.domain);
    } catch (err: unknown) {
      // The provider could not answer with certainty: visible, named failure.
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: message };
    }

    if (verdict.action === 'skip') {
      return {
        status: 'skipped',
        reason: verdict.reason,
        detail: {
          ...verdict.detail,
          instructions: formatDelegationInstructions(ctx.domain, this.#gate.targetRecords()),
        },
      };
    }

    if (verdict.action === 'done') {
      return {
        status: 'done',
        message: 'domain already resolves to the parking target',
        detail: { reason: verdict.reason },
      };
    }

    let applied: DnsWriteOutcome;
    try {
      applied = await this.#gate.apply(ctx.domain);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: message };
    }

    const confirmed = await this.#gate.confirm(ctx.domain);
    if (!confirmed) {
      // Half-completed write: the journal keeps a named, recoverable state.
      return {
        status: 'failed',
        error:
          'write_unconfirmed: records applied but the domain does not resolve to the target yet',
        detail: { domain: ctx.domain },
      };
    }

    return {
      status: 'done',
      message:
        applied.changed.length > 0
          ? 'delegated to the parking target'
          : 'delegation already in place',
      detail: {
        changed: applied.changed.length,
        records: this.#gate.targetRecords(),
      },
    };
  }
}
