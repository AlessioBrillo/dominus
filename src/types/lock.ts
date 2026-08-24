// SPDX-License-Identifier: AGPL-3.0-only
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
  ): Promise<{ acquired: boolean; fenceToken: string | undefined }>;

  /**
   * Renew a lock using the fence token returned by tryLockWithFence.
   * Returns true if renewal succeeded (token matches current holder), false otherwise.
   */
  renewLockWithFence(lockName: string, ttlMs: number, fenceToken: string): Promise<boolean>;

  /**
   * Release a lock using the fence token returned by tryLockWithFence.
   * Only succeeds if the fenceToken matches the current lock holder.
   */
  unlockWithFence(lockName: string, fenceToken: string): Promise<void>;
}
