import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
import type { RegistrarRegistration } from './registrar-registry.js';

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

  static readonly registration: RegistrarRegistration = {
    name: 'manual',
    displayName: 'Manual (No Automation)',
    descriptor: {
      name: 'manual',
      displayName: 'Manual (No Automation)',
      description:
        'Safe default — all registrar operations must be performed manually by the operator. DOMINUS tracks the portfolio but does not automate registration, renewal, or transfers.',
      website: '',
      docsUrl: '',
      configFields: [],
      supportedTlds: ['*'],
      features: [
        'No API key required',
        'Operator handles all registrar interactions manually',
        'Zero risk of accidental purchases',
      ],
    },
    create: () => new ManualRegistrarProvider(),
  };

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    return domains.map((domain) => ({
      domain,
      // Manual registrar cannot determine availability — return true (undetermined)
      // so the purchase flow can proceed for recording purposes.
      available: true,
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      checkedAt: new Date().toISOString(),
    }));
  }

  async purchase(request: RegistrarPurchaseRequest): Promise<RegistrarPurchaseResult> {
    // Manual registrar accepts the recording request. Price is 0 because
    // the operator pays the external registrar directly. The operator can
    // set the actual acquisition cost via `dominus portfolio update`.
    return {
      domain: request.domain,
      success: true,
      priceEur: 0,
      renewalPriceEur: 0,
      message:
        'Manual purchase recorded. Use `dominus portfolio update-costs` to set the actual acquisition price.',
    };
  }

  async listDomains(): Promise<RegistrarDomainInfo[]> {
    return [];
  }

  async getRenewalCost(_domain: string): Promise<number> {
    return 0;
  }
}
