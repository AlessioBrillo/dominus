import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';

/**
 * ManualRegistrarProvider is the default registrar implementation for
 * DOMINUS. Every method returns a result indicating that the operation
 * must be performed manually by the operator.
 *
 * This is the safe default: the operator evaluates buy/pass decisions
 * inside DOMINUS and executes registrations, renewals, and transfers
 * through their chosen registrar's web interface. DOMINUS tracks the
 * portfolio state but does not automate registrar operations.
 *
 * Migrating to an automated registrar is a one-file change: implement
 * the same RegistrarProvider interface and swap the instance in the
 * composition root (src/index.ts).
 */
export class ManualRegistrarProvider implements RegistrarProvider {
  readonly name = 'manual';

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    return domains.map((domain) => ({
      domain,
      available: false,
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      checkedAt: new Date().toISOString(),
    }));
  }

  async purchase(_request: RegistrarPurchaseRequest): Promise<RegistrarPurchaseResult> {
    return {
      domain: _request.domain,
      success: false,
      priceEur: 0,
      renewalPriceEur: 0,
      error: 'Manual purchase required. DOMINUS does not automate registrar operations.',
      message:
        'Use your registrar dashboard to register this domain, then record it with `dominus portfolio add`.',
    };
  }

  async listDomains(): Promise<RegistrarDomainInfo[]> {
    return [];
  }

  async getRenewalCost(_domain: string): Promise<number> {
    return 0;
  }
}
