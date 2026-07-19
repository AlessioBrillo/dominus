import type { RdapResult } from '../../types/domain-status.js';

export interface RdapProvider {
  readonly name: string;
  confirm(domain: string, signal?: AbortSignal): Promise<RdapResult>;
  /** Optional: clear any in-memory caches. Called at pipeline run start. */
  clearCache?: () => void;
}
