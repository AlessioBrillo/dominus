import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('detects IPv6 parking IP', () => {
    const registry = new ParkingIpRegistry([{ name: 'IPv6Host', cidr: ['2001:db8::/32'] }]);
    expect(registry.checkIp('2001:db8::1')).toBe('IPv6Host');
    expect(registry.checkIp('2001:db8:ffff::42')).toBe('IPv6Host');
  });

  it('returns null for IPv6 outside range', () => {
    const registry = new ParkingIpRegistry([{ name: 'IPv6Host', cidr: ['2001:db8::/32'] }]);
    expect(registry.checkIp('2002::1')).toBeNull();
  });

  it('detects /64 IPv6 range boundary', () => {
    const registry = new ParkingIpRegistry([{ name: 'V6Small', cidr: ['2a00:1450:4000::/64'] }]);
    expect(registry.checkIp('2a00:1450:4000::1')).toBe('V6Small');
    expect(registry.checkIp('2a00:1450:4000:0:abcd::42')).toBe('V6Small');
    expect(registry.checkIp('2a00:1450:4001::1')).toBeNull();
  });

  it('detects /0 IPv6 range (everything)', () => {
    const registry = new ParkingIpRegistry([{ name: 'AllV6', cidr: ['::/0'] }]);
    expect(registry.checkIp('::1')).toBe('AllV6');
    expect(registry.checkIp('2001:db8::42')).toBe('AllV6');
    expect(registry.checkIp('ff02::1')).toBe('AllV6');
  });

  it('detects IPv6 with :: compression', () => {
    const registry = new ParkingIpRegistry([{ name: 'Compressed', cidr: ['2600::/4'] }]);
    expect(registry.checkIp('2607:f8b0::1')).toBe('Compressed');
    expect(registry.checkIp('2610::abcd')).toBe('Compressed');
    expect(registry.checkIp('3000::')).toBeNull();
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

  it('load parses valid JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dominus-test-'));
    const file = join(dir, 'parking.json');
    writeFileSync(file, JSON.stringify(TEST_RANGES));
    const registry = ParkingIpRegistry.load(file);
    expect(registry.checkIp('208.109.100.50')).toBe('GoDaddy');
  });

  it('load returns empty registry for malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dominus-test-'));
    const file = join(dir, 'bad.json');
    writeFileSync(file, 'not json');
    const registry = ParkingIpRegistry.load(file);
    expect(registry.checkIp('1.2.3.4')).toBeNull();
  });

  it('handles IPv6 address in full form without ::', () => {
    const registry = new ParkingIpRegistry([{ name: 'V6Full', cidr: ['2001:db8::/32'] }]);
    expect(registry.checkIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('V6Full');
  });

  it('handles IPv6 address with zone ID', () => {
    const registry = new ParkingIpRegistry([{ name: 'V6Zone', cidr: ['fe80::/10'] }]);
    expect(registry.checkIp('fe80::1%eth0')).toBe('V6Zone');
  });
});
