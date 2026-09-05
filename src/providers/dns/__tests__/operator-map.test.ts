// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getOperatorMap,
  getOperatorForIdentity,
  getIdentitiesForOperator,
  areSameOperator,
  getOperatorMapVersion,
  getOperatorMapSource,
  refreshOperatorMap,
  clearOperatorMapCache,
  EMBEDDED_OPERATOR_MAP,
} from '../operator-map.js';

describe('OperatorMap', () => {
  beforeEach(() => {
    clearOperatorMapCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    clearOperatorMapCache();
  });

  describe('EMBEDDED_OPERATOR_MAP', () => {
    it('should contain known operators', () => {
      expect(EMBEDDED_OPERATOR_MAP['doh:cloudflare-dns.com']).toBe('cloudflare');
      expect(EMBEDDED_OPERATOR_MAP['doh:dns.google']).toBe('google');
      expect(EMBEDDED_OPERATOR_MAP['dot:8.8.8.8']).toBe('google');
      expect(EMBEDDED_OPERATOR_MAP['ip:1.1.1.1']).toBe('cloudflare');
      expect(EMBEDDED_OPERATOR_MAP['ip:9.9.9.9']).toBe('quad9');
    });

    it('should have reasonable size', () => {
      expect(Object.keys(EMBEDDED_OPERATOR_MAP).length).toBeGreaterThan(50);
    });
  });

  describe('getOperatorMap', () => {
    it('should return an OperatorMap with expected structure', async () => {
      const map = await getOperatorMap();

      expect(map).toBeDefined();
      expect(map.identityToOperator).toBeInstanceOf(Map);
      expect(map.operatorToIdentities).toBeInstanceOf(Map);
      expect(typeof map.version).toBe('string');
      expect(typeof map.loadedAt).toBe('string');
      expect(['embedded', 'registry']).toContain(map.source);
    });

    it('should return cached map on subsequent calls', async () => {
      const map1 = await getOperatorMap();
      const map2 = await getOperatorMap();
      expect(map1).toBe(map2);
    });

    it('should contain cloudflare entries', async () => {
      const map = await getOperatorMap();
      expect(map.identityToOperator.get('doh:cloudflare-dns.com')).toBe('cloudflare');
      expect(map.identityToOperator.get('ip:1.1.1.1')).toBe('cloudflare');
      expect(map.identityToOperator.get('native:1.1.1.1')).toBe('cloudflare');
    });

    it('should have operatorToIdentities reverse map', async () => {
      const map = await getOperatorMap();
      const cloudflareIdentities = map.operatorToIdentities.get('cloudflare');
      expect(cloudflareIdentities).toBeDefined();
      expect(cloudflareIdentities!.size).toBeGreaterThan(0);
      expect(cloudflareIdentities!.has('doh:cloudflare-dns.com')).toBe(true);
    });
  });

  describe('getOperatorForIdentity', () => {
    it('should return operator for known identity', async () => {
      const op = await getOperatorForIdentity('doh:cloudflare-dns.com');
      expect(op).toBe('cloudflare');
    });

    it('should return undefined for unknown identity', async () => {
      const op = await getOperatorForIdentity('doh:unknown.example.com');
      expect(op).toBeUndefined();
    });
  });

  describe('getIdentitiesForOperator', () => {
    it('should return identities for known operator', async () => {
      const identities = await getIdentitiesForOperator('cloudflare');
      expect(identities).toBeDefined();
      expect(identities!.size).toBeGreaterThan(0);
      expect(identities!.has('doh:cloudflare-dns.com')).toBe(true);
    });

    it('should return undefined for unknown operator', async () => {
      const identities = await getIdentitiesForOperator('unknown-operator');
      expect(identities).toBeUndefined();
    });
  });

  describe('areSameOperator', () => {
    it('should return true for same operator', async () => {
      const result = await areSameOperator('doh:cloudflare-dns.com', 'ip:1.1.1.1');
      expect(result).toBe(true);
    });

    it('should return false for different operators', async () => {
      const result = await areSameOperator('doh:cloudflare-dns.com', 'doh:dns.google');
      expect(result).toBe(false);
    });

    it('should return false when one identity is unknown', async () => {
      const result = await areSameOperator('doh:cloudflare-dns.com', 'doh:unknown.example.com');
      expect(result).toBe(false);
    });
  });

  describe('getOperatorMapVersion', () => {
    it('should return version string', async () => {
      const version = await getOperatorMapVersion();
      expect(typeof version).toBe('string');
      expect(version.length).toBeGreaterThan(0);
    });
  });

  describe('getOperatorMapSource', () => {
    it('should return embedded or registry', async () => {
      const source = await getOperatorMapSource();
      expect(['embedded', 'registry']).toContain(source);
    });
  });

  describe('refreshOperatorMap', () => {
    it('should clear cache and return new map', async () => {
      await getOperatorMap();
      await refreshOperatorMap();
      const map2 = await getOperatorMap();
      // After refresh, should get a new map instance (though may be same if registry unavailable)
      expect(map2).toBeDefined();
    });
  });

  describe('clearOperatorMapCache', () => {
    it('should allow fresh load after clear', async () => {
      const map1 = await getOperatorMap();
      clearOperatorMapCache();
      const map2 = await getOperatorMap();
      // After clear, should get a new map instance
      expect(map2).toBeDefined();
      expect(map1).not.toBe(map2);
    });
  });

  describe('OperatorMap structure', () => {
    it('should have all required fields', async () => {
      const map = await getOperatorMap();
      expect(map).toHaveProperty('identityToOperator');
      expect(map).toHaveProperty('operatorToIdentities');
      expect(map).toHaveProperty('version');
      expect(map).toHaveProperty('loadedAt');
      expect(map).toHaveProperty('source');
    });

    it('should have consistent forward and reverse maps', async () => {
      const map = await getOperatorMap();
      for (const [identity, operator] of map.identityToOperator) {
        const reverse = map.operatorToIdentities.get(operator);
        expect(reverse).toBeDefined();
        expect(reverse!.has(identity)).toBe(true);
      }
    });
  });
});
