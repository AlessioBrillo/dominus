import type { RdapResult } from '../../types/domain-status.js';

export interface RdapProvider {
  confirm(domain: string, signal?: AbortSignal): Promise<RdapResult>;
}
