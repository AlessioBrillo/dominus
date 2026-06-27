import { describe, it, expect } from 'vitest';
import { ParkingIpRegistry, type ParkingRange } from '../parking-ip-registry.js';

const TEST_RANGES: ParkingRange[] = [
  {
    name: 'GoDaddy',
    cidr: ['208.109.0.0/16', '64.202.0.0/16'],
  },
  {
    name: 'Sedo',
    cidr: ['91.195.240.0/22'],
  },
  {
    name: 'Cloudflare',
    cidr: ['104.16.0.0/12'],
  },
];

describe('ParkingIpRegistry', () => {
  it('detects a known parking IP', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    expect(registry.checkIp('208.109.100.50')).toBe('GoDaddy');
  });

  it('detects second range in same registrar', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    expect(registry.checkIp('64.202.1.1')).toBe('GoDaddy');
  });

  it('detects /22 range boundary (Sedo)', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    expect(registry.checkIp('91.195.240.1')).toBe('Sedo');
    expect(registry.checkIp('91.195.243.255')).toBe('Sedo');
    expect(registry.checkIp('91.195.239.255')).toBeNull();
    expect(registry.checkIp('91.195.244.0')).toBeNull();
  });

  it('detects large /12 range (Cloudflare)', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    expect(registry.checkIp('104.31.255.255')).toBe('Cloudflare');
    expect(registry.checkIp('104.0.0.1')).toBeNull();
  });

  it('returns null for non-parked IP', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    expect(registry.checkIp('8.8.8.8')).toBeNull();
  });

  it('returns null for IPv6 addresses', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    expect(registry.checkIp('::1')).toBeNull();
    expect(registry.checkIp('2001:db8::1')).toBeNull();
  });

  it('returns null for invalid IP', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    expect(registry.checkIp('999.999.999.999')).toBeNull();
    expect(registry.checkIp('not-an-ip')).toBeNull();
  });

  it('checkIps returns parked=true and registrar name on first match', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    const result = registry.checkIps(['8.8.8.8', '208.109.50.50', '1.2.3.4']);
    expect(result.parked).toBe(true);
    expect(result.registrar).toBe('GoDaddy');
  });

  it('checkIps returns parked=false when no IPs match', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    const result = registry.checkIps(['8.8.8.8', '1.2.3.4']);
    expect(result.parked).toBe(false);
    expect(result.registrar).toBeUndefined();
  });

  it('checkIps returns parked=false for empty array', () => {
    const registry = new ParkingIpRegistry(TEST_RANGES);
    const result = registry.checkIps([]);
    expect(result.parked).toBe(false);
  });

  it('handles /32 exact match', () => {
    const registry = new ParkingIpRegistry([{ name: 'Exact', cidr: ['10.0.0.1/32'] }]);
    expect(registry.checkIp('10.0.0.1')).toBe('Exact');
    expect(registry.checkIp('10.0.0.2')).toBeNull();
  });

  it('handles /0 (everything) match', () => {
    const registry = new ParkingIpRegistry([{ name: 'Everything', cidr: ['0.0.0.0/0'] }]);
    expect(registry.checkIp('1.2.3.4')).toBe('Everything');
    expect(registry.checkIp('255.255.255.255')).toBe('Everything');
  });

  it('load returns empty registry for non-existent file', () => {
    const registry = ParkingIpRegistry.load('./non-existent-file.json');
    expect(registry.checkIp('1.2.3.4')).toBeNull();
  });

  it('load returns empty registry for undefined path', () => {
    const registry = ParkingIpRegistry.load(undefined);
    expect(registry.checkIp('1.2.3.4')).toBeNull();
  });
});
