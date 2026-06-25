import type { Config } from '../config.js';
import { registrarRegistry } from '../providers/registrar/registrar-registry.js';
import { loadFileConfig } from '../providers/file-config-loader.js';
import type { RegistrarProvider } from '../providers/registrar/registrar-provider.js';
import { AutoApprovalPolicy, PurchaseService } from '../services/purchase-service.js';
import type { PortfolioManager } from '../portfolio/index.js';
import type { OutcomeRepository } from '../db/index.js';
import type { ScoringEngine } from '../scoring/index.js';
import type { TrademarkGate } from '../trademark/index.js';
import type { AutoListingService } from '../services/auto-listing-service.js';

export function buildRegistrarProvider(config: Config): RegistrarProvider {
  const registrarConfig: Record<string, string> = {};
  const registrarProviderName = config.REGISTRAR_PROVIDER;
  const registrarEnvPrefix = `REGISTRAR_${registrarProviderName.replace(/-/g, '_').toUpperCase()}_`;

  // 1. Load from env vars (takes precedence)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(registrarEnvPrefix) && value !== undefined) {
      const fieldKey = key.slice(registrarEnvPrefix.length).toLowerCase();
      registrarConfig[fieldKey] = value;
    }
  }

  // 2. Load from file-based config as fallback (more secure — not in /proc/self/environ)
  const filePath = config.FILE_REGISTRAR_CONFIG;
  if (filePath) {
    try {
      const fileConfig = loadFileConfig(filePath);
      const filePrefix = `registrar_${registrarProviderName.toLowerCase()}_`;
      for (const [key, value] of Object.entries(fileConfig)) {
        if (key.startsWith(filePrefix)) {
          const fieldKey = key.slice(filePrefix.length);
          registrarConfig[fieldKey] ??= value;
        }
      }
    } catch {
      // File read error is non-fatal
    }
  }

  // 3. Pass legacy Cloudflare vars for backward compat
  if (registrarProviderName === 'cloudflare') {
    registrarConfig['apiToken'] = config.CLOUDFLARE_API_TOKEN ?? registrarConfig['apitoken'] ?? '';
    registrarConfig['accountId'] =
      config.CLOUDFLARE_ACCOUNT_ID ?? registrarConfig['accountid'] ?? '';
  }

  return registrarRegistry.createActive(registrarProviderName, registrarConfig);
}

export function buildPurchaseService(
  registrar: RegistrarProvider,
  portfolioManager: PortfolioManager,
  outcomeRepo: OutcomeRepository,
  engine: ScoringEngine,
  gate: TrademarkGate,
  config: Config,
  autoListing?: AutoListingService,
): PurchaseService {
  const autoApprovalMap: Record<string, AutoApprovalPolicy> = {
    never: AutoApprovalPolicy.Never,
    under_buy_max: AutoApprovalPolicy.UnderBuyMax,
    always: AutoApprovalPolicy.Always,
  };

  return new PurchaseService({
    registrar,
    portfolioManager,
    outcomeRepo,
    engine,
    gate,
    autoApproval: autoApprovalMap[config.PURCHASE_AUTO_APPROVAL] ?? AutoApprovalPolicy.Never,
    buyMaxAbsoluteCap: config.BUY_MAX_ABSOLUTE_CAP,
    autoListing,
  });
}
