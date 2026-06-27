import { existsSync, readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';

export interface ParkingRange {
  name: string;
  cidr: string[];
}

interface CidrEntry {
  name: string;
  base: number;
  mask: number;
}

function cidrToMask(prefix: number): number {
  if (prefix === 0) return 0;
  return ~0 << (32 - prefix);
}

function ipToInt(ip: string): number {
  const parts = ip.split('.');
  return ((+parts[0]! << 24) | (+parts[1]! << 16) | (+parts[2]! << 8) | +parts[3]!) >>> 0;
}

function parseCidr(cidr: string): { base: number; mask: number } | null {
  const idx = cidr.indexOf('/');
  if (idx === -1) return null;
  const ip = cidr.slice(0, idx);
  const prefix = parseInt(cidr.slice(idx + 1), 10);
  if (!isIPv4(ip) || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  return { base: ipToInt(ip), mask: cidrToMask(prefix) };
}

export class ParkingIpRegistry {
  readonly #entries: CidrEntry[];

  constructor(ranges: ParkingRange[]) {
    this.#entries = [];
    for (const range of ranges) {
      for (const cidr of range.cidr) {
        const parsed = parseCidr(cidr);
        if (parsed !== null) {
          this.#entries.push({ name: range.name, ...parsed });
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
    if (!isIPv4(ip)) return null;
    const ipInt = ipToInt(ip);
    for (const entry of this.#entries) {
      if ((ipInt & entry.mask) >>> 0 === entry.base) {
        return entry.name;
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
