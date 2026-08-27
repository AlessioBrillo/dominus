// SPDX-License-Identifier: AGPL-3.0-only
export interface LockMetadata {
  /** Unique identifier for the pipeline run. */
  runId: string;
  /** Current pipeline stage (e.g., 'CandidateGeneration', 'DnsPreFilter', 'RdapConfirmation', 'Scoring', 'TrademarkGate'). */
  stage?: string;
  /** Priority hint for lock acquisition ordering. */
  priority?: 'high' | 'normal' | 'low';
  /** Optional tenant identifier for multi-tenant observability. */
  tenantId?: string;
  /** Timestamp when the lock was acquired (ISO 8601). */
  acquiredAt?: string;
}

export interface LockProvider {
  tryLock(lockName: string, ttlMs: number): Promise<boolean>;
  renewLock(lockName: string, ttlMs: number): Promise<boolean>;
  unlock(lockName: string): Promise<void>;

  /**
   * Acquire a lock with a fencing token.
   * Returns { acquired: true, fenceToken } on success, { acquired: false, fenceToken: undefined } on failure.
   * The fenceToken must be presented to renewLockWithFence and unlockWithFence
   * to prevent split-brain scenarios where a lock is stolen by another process.
   */
  tryLockWithFence(
    lockName: string,
    ttlMs: number,
    metadata?: LockMetadata,
  ): Promise<{ acquired: boolean; fenceToken: string | undefined }>;

  /**
   * Renew a lock using the fence token returned by tryLockWithFence.
   * Returns true if renewal succeeded (token matches current holder), false otherwise.
   */
  renewLockWithFence(
    lockName: string,
    ttlMs: number,
    fenceToken: string,
    metadata?: LockMetadata,
  ): Promise<boolean>;

  /**
   * Release a lock using the fence token returned by tryLockWithFence.
   * Only succeeds if the fenceToken matches the current lock holder.
   */
  unlockWithFence(lockName: string, fenceToken: string, metadata?: LockMetadata): Promise<void>;
}
