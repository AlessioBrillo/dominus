import { DomainStatus } from '../../types/domain-status.js';
import type { RdapResult } from '../../types/domain-status.js';
import { ProviderError } from '../../types/errors.js';
import type { RdapProvider } from './rdap-provider.js';

const RDAP_BOOTSTRAP_URL = 'https://rdap.org/domain/';

interface RdapResponse {
  ldhName?: string;
  status?: string[];
  notices?: { description?: string[] }[];
}

export class PublicRdapProvider implements RdapProvider {
  async confirm(domain: string): Promise<RdapResult> {
    const url = `${RDAP_BOOTSTRAP_URL}${encodeURIComponent(domain)}`;
    let response: Response;

    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err: unknown) {
      throw new ProviderError(
        `RDAP request failed for ${domain}: ${String(err)}`,
        'PublicRdapProvider',
      );
    }

    if (response.status === 404) {
      return {
        domain,
        status: DomainStatus.Available,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      };
    }

    if (!response.ok) {
      return {
        domain,
        status: DomainStatus.Unknown,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      };
    }

    const data = (await response.json()) as RdapResponse;
    const isPremium = this.detectPremium(data);

    return {
      domain,
      status: DomainStatus.Registered,
      isPremium,
      checkedAt: new Date().toISOString(),
      rawResponse: data,
    };
  }

  private detectPremium(data: RdapResponse): boolean {
    const notices = data.notices ?? [];
    return notices.some((n) =>
      (n.description ?? []).some((d) => /premium/i.test(d)),
    );
  }
}
