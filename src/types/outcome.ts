/**
 * Real-world events that close the loop between the scoring engine's
 * predictions and the operator's actual portfolio outcomes.
 *
 * Outcomes are the *truth* the engine will eventually be retrained
 * against. The taxonomy is intentionally narrow but the optional fields
 * are wide so the operator can capture enough context to do useful
 * post-hoc analysis without changing the schema.
 *
 * Type semantics:
 *  - `Sold`        — the domain changed hands for `salePriceEur` (net of
 *                    fees). The capital was realised.
 *  - `Dropped`     — the operator let the domain expire on purpose
 *                    (capital intentionally written off). Implies
 *                    `verdict = Drop` was honored.
 *  - `Expired`     — the domain lapsed by accident (no renewal). The
 *                    operator lost the asset. Distinct from `Dropped`
 *                    because it indicates a process failure.
 *  - `Renewed`     — the domain was renewed for another year. Implicit
 *                    decision to keep holding. The negative-outcome
 *                    signal (no sale yet) feeds the time-to-sell
 *                    metric.
 *
 * The enum is a string union kept open (string at the DB layer) so
 * new event types can be added without a migration. The application
 * layer validates `type` against this enum at the boundary.
 */

export type OutcomeType = 'sold' | 'dropped' | 'expired' | 'renewed' | 'purchased';

export const OUTCOME_TYPES: readonly OutcomeType[] = [
  'sold',
  'dropped',
  'expired',
  'renewed',
  'purchased',
] as const;

export function isOutcomeType(value: unknown): value is OutcomeType {
  return typeof value === 'string' && (OUTCOME_TYPES as readonly string[]).includes(value);
}

export interface Outcome {
  id?: number;
  domain: string;
  type: OutcomeType;
  /** ISO-8601 timestamp marking when the event actually happened. */
  occurredAt: string;
  /** Required semantically for `Sold`; kept optional at the type level
   *  to avoid forced UX prompts for non-sale events. */
  salePriceEur?: number | undefined;
  /** The price the domain was listed at when it sold, if known. Lets
   *  the retraining loop distinguish "sold at list" from "sold under
   *  list" — two very different signals. */
  listingPriceEur?: number | undefined;
  /** Wall-clock days the domain was listed before this outcome. */
  daysListed?: number | undefined;
  /** Marketplace / venue the outcome occurred on (e.g. "sedo",
   *  "afternic", "dan.com", "private"). */
  venue?: string | undefined;
  /** Commission paid on the transaction, as a percentage of
   *  `salePriceEur` (e.g. 15 for a 15% commission). */
  commissionPct?: number | undefined;
  notes?: string | undefined;
  createdAt?: string | undefined;
}

export interface RecordOutcomeInput {
  domain: string;
  type: OutcomeType;
  occurredAt: string;
  salePriceEur?: number | undefined;
  listingPriceEur?: number | undefined;
  daysListed?: number | undefined;
  venue?: string | undefined;
  commissionPct?: number | undefined;
  notes?: string | undefined;
}
