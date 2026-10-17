// SPDX-License-Identifier: AGPL-3.0-only
export type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
export { ManualRegistrarProvider } from './manual-registrar-provider.js';
export { CloudflareRegistrarProvider } from './cloudflare-registrar-provider.js';
export { DynadotRegistrarProvider } from './dynadot-registrar-provider.js';
export { PorkbunRegistrarProvider } from './porkbun-registrar-provider.js';
export { NamecheapRegistrarProvider } from './namecheap-registrar-provider.js';
export { RegistrarRegistry, registrarRegistry } from './registrar-registry.js';
export type { RegistrarRegistration } from './registrar-registry.js';
