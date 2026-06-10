import { describe, it, expect } from 'vitest';
import { RegistrarRegistry } from '../registrar-registry.js';

describe('RegistrarRegistry', () => {
  it('registers all 7 default registrars', () => {
    const registry = new RegistrarRegistry();
    const names = registry.getNames();
    expect(names).toContain('manual');
    expect(names).toContain('cloudflare');
    expect(names).toContain('namecheap');
    expect(names).toContain('godaddy');
    expect(names).toContain('porkbun');
    expect(names).toContain('namesilo');
    expect(names).toContain('dynadot');
    expect(names).toHaveLength(7);
  });

  it('returns descriptor for a known registrar', () => {
    const registry = new RegistrarRegistry();
    const desc = registry.getDescriptor('cloudflare');
    expect(desc).toBeDefined();
    expect(desc?.name).toBe('cloudflare');
    expect(desc?.displayName).toBe('Cloudflare');
    expect(desc?.configFields.length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown registrar', () => {
    const registry = new RegistrarRegistry();
    expect(registry.getDescriptor('nonexistent')).toBeUndefined();
  });

  it('lists all descriptors', () => {
    const registry = new RegistrarRegistry();
    const descriptors = registry.listDescriptors();
    expect(descriptors).toHaveLength(7);
    expect(descriptors.map((d) => d.name)).toContain('manual');
  });

  it('creates an instance of a registered registrar', () => {
    const registry = new RegistrarRegistry();
    const provider = registry.create('manual', {});
    expect(provider.name).toBe('manual');
  });

  it('throws for unknown registrar on create', () => {
    const registry = new RegistrarRegistry();
    expect(() => registry.create('unknown', {})).toThrow();
  });

  it('createActive returns manual when no name given', () => {
    const registry = new RegistrarRegistry();
    const provider = registry.createActive(undefined, {});
    expect(provider.name).toBe('manual');
  });

  it('createActive returns manual when name is manual', () => {
    const registry = new RegistrarRegistry();
    const provider = registry.createActive('manual', {});
    expect(provider.name).toBe('manual');
  });

  it('createActive creates non-manual registrar', () => {
    const registry = new RegistrarRegistry();
    const provider = registry.createActive('cloudflare', {
      apiToken: 'test-token',
      accountId: 'test-account',
    });
    expect(provider.name).toBe('cloudflare');
  });

  it('supports custom registration', () => {
    const registry = new RegistrarRegistry();
    registry.register({
      name: 'custom',
      displayName: 'Custom Registrar',
      descriptor: {
        name: 'custom',
        displayName: 'Custom',
        description: 'Custom test registrar',
        website: '',
        docsUrl: '',
        configFields: [],
        supportedTlds: ['*'],
        features: [],
      },
      create: () => ({ name: 'custom' }) as ReturnType<typeof registry.create>,
    });
    expect(registry.getNames()).toContain('custom');
  });
});

describe('RegistrarRegistry.envPrefix', () => {
  it('converts name to uppercase with underscores', () => {
    expect(RegistrarRegistry.envPrefix('cloudflare')).toBe('CLOUDFLARE');
  });

  it('replaces hyphens with underscores', () => {
    expect(RegistrarRegistry.envPrefix('name-cheap')).toBe('NAME_CHEAP');
  });
});

describe('RegistrarRegistry.envKey', () => {
  it('builds env key from registrar and field', () => {
    expect(RegistrarRegistry.envKey('cloudflare', 'apiToken')).toBe(
      'REGISTRAR_CLOUDFLARE_API_TOKEN',
    );
  });

  it('handles camelCase field names', () => {
    expect(RegistrarRegistry.envKey('namecheap', 'apiKey')).toBe('REGISTRAR_NAMECHEAP_API_KEY');
  });
});
