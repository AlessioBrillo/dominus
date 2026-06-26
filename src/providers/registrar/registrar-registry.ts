import type { RegistrarProvider } from './registrar-provider.js';
import type { RegistrarDescriptor } from '../../types/registrar.js';
import { RegistrarConfigError } from '../../types/registrar.js';
import { ManualRegistrarProvider } from './manual-registrar-provider.js';

export interface RegistrarRegistration {
  name: string;
  displayName: string;
  descriptor: RegistrarDescriptor;
  create: (config: Record<string, string>) => RegistrarProvider;
}

export class RegistrarRegistry {
  readonly #registrations = new Map<string, RegistrarRegistration>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register(ManualRegistrarProvider.registration);
  }

  register(registration: RegistrarRegistration): void {
    this.#registrations.set(registration.name, registration);
  }

  getNames(): string[] {
    return Array.from(this.#registrations.keys());
  }

  getDescriptor(name: string): RegistrarDescriptor | undefined {
    return this.#registrations.get(name)?.descriptor;
  }

  listDescriptors(): RegistrarDescriptor[] {
    return Array.from(this.#registrations.values()).map((r) => r.descriptor);
  }

  create(name: string, config: Record<string, string>): RegistrarProvider {
    const registration = this.#registrations.get(name);
    if (registration === undefined) {
      throw new RegistrarConfigError(
        name,
        `Unknown registrar "${name}". Available: ${this.getNames().join(', ')}`,
      );
    }
    return registration.create(config);
  }

  /**
   * Create the active registrar provider based on a REGISTRAR_PROVIDER env
   * value and a flat config map of REGISTRAR_<NAME>_<KEY> env vars.
   * Falls back to ManualRegistrarProvider when the env var is unset.
   */
  createActive(
    providerName: string | undefined,
    configMap: Record<string, string>,
  ): RegistrarProvider {
    const name = providerName ?? 'manual';
    if (name === 'manual') return new ManualRegistrarProvider();
    return this.create(name, configMap);
  }

  /**
   * Return the recommended prefix for env-var lookup per registrar.
   * Example: for 'cloudflare' → 'CLOUDFLARE', for 'namecheap' → 'NAMECHEAP'.
   */
  static envPrefix(name: string): string {
    return name.replace(/-/g, '_').toUpperCase();
  }

  /**
   * Return the env-var key for a given registrar and field.
   * Example: ('cloudflare', 'apiToken') → 'REGISTRAR_CLOUDFLARE_API_TOKEN'
   */
  static envKey(registrar: string, fieldKey: string): string {
    const prefix = RegistrarRegistry.envPrefix(registrar);
    const field = fieldKey
      .replace(/([A-Z])/g, '_$1')
      .replace(/^_/, '')
      .toUpperCase();
    return `REGISTRAR_${prefix}_${field}`;
  }
}

export const registrarRegistry = new RegistrarRegistry();
