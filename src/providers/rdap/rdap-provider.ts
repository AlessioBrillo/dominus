import type { RdapResult } from '../../types/domain-status.js';

export interface RdapProvider {
  readonly name: string;
  confirm(domain: string, signal?: AbortSignal): Promise<RdapResult>;
}
