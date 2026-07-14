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
  return ~0 << (32 - prefix);
}

function ipToInt(ip: string): number {
  const parts = ip.split('.');
  return ((+parts[0]! << 24) | (+parts[1]! << 16) | (+parts[2]! << 8) | +parts[3]!) >>> 0;
}

function ipv6ToBigint(ip: string): bigint {
  const bytes = ip.includes('%') ? ip.split('%')[0]! : ip;
  const buf = new Uint8Array(16);
  if (bytes === '::') return 0n;
  const groups = bytes.split(':');
  let i = 0;
  for (const g of groups) {
    if (g === '') continue;
    const val = parseInt(g, 16);
    if (!isNaN(val)) {
      buf[i++] = (val >> 8) & 0xff;
      buf[i++] = val & 0xff;
    }
  }
  // Handle :: compression
  if (bytes.includes('::')) {
    const parts = bytes.split('::');
    const left = parts[0]!.split(':').filter(Boolean);
    const right = parts[1]!.split(':').filter(Boolean);
    const missing = 8 - left.length - right.length;
    const expanded: string[] = [];
    for (const p of left) expanded.push(p);
    for (let j = 0; j < missing; j++) expanded.push('0');
    for (const p of right) expanded.push(p);
    const buf2 = new Uint8Array(16);
    for (let j = 0; j < 8; j++) {
      const val = parseInt(expanded[j] || '0', 16);
      buf2[j * 2] = (val >> 8) & 0xff;
      buf2[j * 2 + 1] = val & 0xff;
    }
    let result = 0n;
    for (let j = 0; j < 16; j++) {
      result = (result << 8n) | BigInt(buf2[j]!);
    }
    return result;
  }
  let result = 0n;
  for (let j = 0; j < i; j++) {
    result = (result << 8n) | BigInt(buf[j]!);
  }
  return result;
}

function cidrToMaskV6(prefix: number): bigint {
  if (prefix === 0) return 0n;
  if (prefix >= 128) return 0xffffffffffffffffffffffffffffffffn;
  return (
    (0xffffffffffffffffffffffffffffffffn << BigInt(128 - prefix)) &
    0xffffffffffffffffffffffffffffffffn
  );
}

function parseCidrV4(cidr: string): { base: number; mask: number } | null {
  const idx = cidr.indexOf('/');
  if (idx === -1) return null;
  const ip = cidr.slice(0, idx);
  const prefix = parseInt(cidr.slice(idx + 1), 10);
  if (!isIPv4(ip) || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  return { base: ipToInt(ip), mask: cidrToMask(prefix) };
}

function parseCidrV6(cidr: string): { base: bigint; mask: bigint } | null {
  const idx = cidr.indexOf('/');
  if (idx === -1) return null;
  const ip = cidr.slice(0, idx);
  const prefix = parseInt(cidr.slice(idx + 1), 10);
  if (!isIPv6(ip) || Number.isNaN(prefix) || prefix < 0 || prefix > 128) return null;
  return { base: ipv6ToBigint(ip), mask: cidrToMaskV6(prefix) };
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
