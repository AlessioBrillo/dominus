// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../config.js';
import { registrarRegistry } from '../providers/registrar/registrar-registry.js';
import { loadFileConfig } from '../providers/file-config-loader.js';
import type { RegistrarProvider } from '../providers/registrar/registrar-provider.js';
import { AutoApprovalPolicy, PurchaseService } from '../services/purchase-service.js';
import type { PortfolioManager } from '../portfolio/index.js';
import type { OutcomeRepository } from '../db/index.js';
import type { ScoringEngine } from '../scoring/index.js';
import type { TrademarkGate } from '../trademark/index.js';
import type { AutoListingService, AutoListEnqueuer } from '../services/auto-listing-service.js';
import type { PostAcquisitionTrigger } from '../services/post-acquisition-service.js';

export function buildRegistrarProvider(config: Config): RegistrarProvider {
  return registrarRegistry.createActive(config.REGISTRAR_PROVIDER, resolveRegistrarConfig(config));
}

/**
 * Resolve the flat config map for a registrar provider (ADR-0004):
 * `REGISTRAR_<NAME>_<FIELD>` env vars first, the
 * `registrar_<name>_<field>` keys of FILE_REGISTRAR_CONFIG as fallback.
 * Exported so other modules (e.g. the DNS write provider) can reuse the
 * exact same credential resolution instead of re-inventing it.
 */
export function resolveRegistrarConfig(
  config: Config,
  providerName: string = config.REGISTRAR_PROVIDER,
): Record<string, string> {
  const registrarConfig: Record<string, string> = {};
  const registrarEnvPrefix = `REGISTRAR_${providerName.replace(/-/g, '_').toUpperCase()}_`;

  // 1. Load from env vars (takes precedence)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(registrarEnvPrefix) && value !== undefined) {
      const fieldKey = key
        .slice(registrarEnvPrefix.length)
        .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
        .toLowerCase();
      registrarConfig[fieldKey] = value;
    }
  }

  // 2. Load from file-based config as fallback (more secure — not in /proc/self/environ)
  const filePath = config.FILE_REGISTRAR_CONFIG;
  if (filePath) {
    try {
      const fileConfig = loadFileConfig(filePath);
      const filePrefix = `registrar_${providerName.toLowerCase()}_`;
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

  return registrarConfig;
}

/**
 * Cloudflare API token shared by the registrar integration and the DNS
 * write provider: `DNS_WRITE_CLOUDFLARE_API_TOKEN` first, then the
 * registrar's own token (same account, token carries DNS:Edit).
 */
export function resolveCloudflareApiToken(config: Config): string | undefined {
  return (
    config.DNS_WRITE_CLOUDFLARE_API_TOKEN ?? resolveRegistrarConfig(config, 'cloudflare').apiToken
  );
}

export function buildPurchaseService(
  registrar: RegistrarProvider,
  portfolioManager: PortfolioManager,
  outcomeRepo: OutcomeRepository,
  engine: ScoringEngine,
  gate: TrademarkGate,
  config: Config,
  autoListing?: AutoListingService,
  autoListEnqueuer?: AutoListEnqueuer,
  postAcquisition?: PostAcquisitionTrigger,
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
    autoListEnqueuer,
    postAcquisition,
  });
}
