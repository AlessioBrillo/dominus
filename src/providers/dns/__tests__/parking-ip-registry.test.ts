// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('load falls back to the bundled reference list when no path is given (ADR-0059)', () => {
    const bundled = fileURLToPath(new URL('../parking-ips.json', import.meta.url));
    const registry = ParkingIpRegistry.load(undefined, bundled);
    // The bundled list must carry at least the well-known parking ranges so
    // DNS_PARKING_CHECK_ENABLED=true works out of the box.
    expect(registry.checkIp('208.109.100.50')).toBe('GoDaddy');
  });

  it('load prefers an explicit path over the bundled fallback (ADR-0059)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dominus-test-'));
    const file = join(dir, 'custom.json');
    writeFileSync(file, JSON.stringify([{ name: 'Custom', cidr: ['203.0.113.0/24'] }]));
    const bundled = fileURLToPath(new URL('../parking-ips.json', import.meta.url));
    const registry = ParkingIpRegistry.load(file, bundled);
    expect(registry.checkIp('203.0.113.42')).toBe('Custom');
    expect(registry.checkIp('208.109.100.50')).toBeNull();
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

  // ── Bundled reference list (ADR-0059) ────────────────────────────

  describe('bundled parking reference list', () => {
    const bundledPath = fileURLToPath(new URL('../parking-ips.json', import.meta.url));

    it('ships as a real, non-empty data file', () => {
      // Guards the file the compiled code loads at runtime. It is a .json
      // asset, so `tsc` does not emit it: scripts/finalize-dist.mjs copies
      // it into dist/, and scripts/check-pack.mjs asserts it reaches the
      // tarball. Without all three, DNS_PARKING_CHECK_ENABLED silently
      // degrades to a no-op (a fail-open behaviour, ADR-0059).
      const raw = readFileSync(bundledPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      expect(Array.isArray(parsed)).toBe(true);
      expect((parsed as unknown[]).length).toBeGreaterThan(0);
    });

    it('contains only well-formed CIDR entries', () => {
      const ranges = JSON.parse(readFileSync(bundledPath, 'utf-8')) as ParkingRange[];
      for (const range of ranges) {
        expect(range.name.length).toBeGreaterThan(0);
        expect(range.cidr.length).toBeGreaterThan(0);
        for (const cidr of range.cidr) {
          expect(cidr).toMatch(/^[0-9a-fA-F.:]+\/\d+$/);
        }
      }
    });

    it('detects at least one known parking IP through the registry', () => {
      const registry = ParkingIpRegistry.load(undefined, bundledPath);
      const first = (JSON.parse(readFileSync(bundledPath, 'utf-8')) as ParkingRange[])[0]!;
      const [firstCidr] = first.cidr;
      // Any address inside the first declared range must resolve to that
      // registrar: proves the file actually parses into live entries.
      const probe = probeAddressForCidr(firstCidr!);
      expect(registry.checkIp(probe)).toBe(first.name);
    });
  });
});

/** Returns an address guaranteed to fall inside `cidr`, for probing. */
function probeAddressForCidr(cidr: string): string {
  const [base, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  if (base!.includes(':')) return `${base!.split('::')[0]}::1`;
  const octets = base!.split('.').map(Number);
  // Set the host bits to 1 — always inside the range, never the network or
  // broadcast address, so the registry cannot reject it as an edge case.
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const baseInt = octets.reduce((acc, o) => ((acc << 8) | o) >>> 0, 0) >>> 0;
  const hostBits = ~mask >>> 0;
  const host = hostBits === 0 ? 1 : (hostBits & 0xff) | (hostBits >> 8);
  const addr = ((baseInt & mask) >>> 0) + (host & hostBits);
  return [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff].join('.');
}
