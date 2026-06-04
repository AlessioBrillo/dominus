import type { RdapResult } from '../../types/domain-status.js';

export interface RdapProvider {
  confirm(domain: string): Promise<RdapResult>;
}
