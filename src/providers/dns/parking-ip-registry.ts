import { existsSync, readFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';

export interface ParkingRange {
  name: string;
  cidr: string[];
}

interface CidrEntryV4 {
  name: string;
  base: number;
  mask: number;
}

interface CidrEntryV6 {
  name: string;
  base: bigint;
  mask: bigint;
}

function cidrToMask(prefix: number): number {
  if (prefix === 0) return 0;
  return (~0 << (32 - prefix)) >>> 0;
}

function ipToInt(ip: string): number {
  const parts = ip.split('.');
  return ((+parts[0]! << 24) | (+parts[1]! << 16) | (+parts[2]! << 8) | +parts[3]!) >>> 0;
}

function ipv6ToBigint(ip: string): bigint {
  const clean = ip.includes('%') ? ip.split('%')[0]! : ip;
  const groups: string[] = [];
  if (clean.includes('::')) {
    const parts = clean.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    groups.push(...left, ...Array<string>(missing).fill('0'), ...right);
  } else {
    groups.push(...clean.split(':'));
  }
  let result = 0n;
  for (const g of groups) {
    result = (result << 16n) | BigInt(parseInt(g || '0', 16));
  }
  return result;
}

function cidrToMaskV6(prefix: number): bigint {
  if (prefix === 0) return 0n;
  if (prefix >= 128) return 0xffffffffffffffffffffffffffffffffn;
  const allOnes = (1n << 128n) - 1n;
  const lowerZeros = (1n << BigInt(128 - prefix)) - 1n;
  return allOnes ^ lowerZeros;
}

function parseCidrV4(cidr: string): { base: number; mask: number } | null {
  const idx = cidr.indexOf('/');
  if (idx === -1) return null;
  const ip = cidr.slice(0, idx);
  const prefix = parseInt(cidr.slice(idx + 1), 10);
  if (!isIPv4(ip) || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = cidrToMask(prefix);
  return { base: (ipToInt(ip) & mask) >>> 0, mask };
}

function parseCidrV6(cidr: string): { base: bigint; mask: bigint } | null {
  const idx = cidr.indexOf('/');
  if (idx === -1) return null;
  const ip = cidr.slice(0, idx);
  const prefix = parseInt(cidr.slice(idx + 1), 10);
  if (!isIPv6(ip) || Number.isNaN(prefix) || prefix < 0 || prefix > 128) return null;
  const mask = cidrToMaskV6(prefix);
  return { base: ipv6ToBigint(ip) & mask, mask };
}

export class ParkingIpRegistry {
  readonly #v4: CidrEntryV4[];
  readonly #v6: CidrEntryV6[];

  constructor(ranges: ParkingRange[]) {
    this.#v4 = [];
    this.#v6 = [];
    for (const range of ranges) {
      for (const cidr of range.cidr) {
        const v4parsed = parseCidrV4(cidr);
        if (v4parsed !== null) {
          this.#v4.push({ name: range.name, ...v4parsed });
          continue;
        }
        const v6parsed = parseCidrV6(cidr);
        if (v6parsed !== null) {
          this.#v6.push({ name: range.name, ...v6parsed });
        }
      }
    }
  }

  static load(path: string | undefined): ParkingIpRegistry {
    if (path === undefined || !existsSync(path)) {
      return new ParkingIpRegistry([]);
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      const ranges = Array.isArray(raw) ? (raw as ParkingRange[]) : [];
      return new ParkingIpRegistry(ranges);
    } catch {
      return new ParkingIpRegistry([]);
    }
  }

  checkIp(ip: string): string | null {
    if (isIPv4(ip)) {
      const ipInt = ipToInt(ip);
      for (const entry of this.#v4) {
        if ((ipInt & entry.mask) >>> 0 === entry.base) {
          return entry.name;
        }
      }
    } else if (isIPv6(ip)) {
      const ipInt = ipv6ToBigint(ip);
      for (const entry of this.#v6) {
        if ((ipInt & entry.mask) === entry.base) {
          return entry.name;
        }
      }
    }
    return null;
  }

  checkIps(ips: string[]): { parked: boolean; registrar?: string } {
    for (const ip of ips) {
      const name = this.checkIp(ip);
      if (name !== null) {
        return { parked: true, registrar: name };
      }
    }
    return { parked: false };
  }
}
