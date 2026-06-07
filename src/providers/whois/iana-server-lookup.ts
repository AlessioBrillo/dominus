import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';

const IANA_WHOIS_HOST = 'whois.iana.org';
const IANA_WHOIS_PORT = 43;
const CACHE_TTL_MS = 60 * 60 * 1000;

const cached = new Map<string, { server: string; expiresAt: number }>();

function isExpired(entry: { expiresAt: number }): boolean {
  return Date.now() > entry.expiresAt;
}

type ConnectFn = (port: number, host: string, callback?: () => void) => Socket;

function queryIanaWhois(tld: string, connectFn: ConnectFn = netConnect): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connectFn(IANA_WHOIS_PORT, IANA_WHOIS_HOST, () => {
      socket.write(`${tld}\r\n`);
    });

    const chunks: Buffer[] = [];
    const timeout = 10_000;

    socket.setTimeout(timeout);

    socket.on('data', (data: Buffer) => {
      chunks.push(data);
    });

    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      resolve(raw);
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`IANA WHOIS lookup timed out for TLD: ${tld}`));
    });

    socket.on('error', (err) => {
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function parseWhoisServer(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim().toLowerCase();
    if (trimmed.startsWith('whois:')) {
      const server = trimmed.slice(6).trim();
      if (server.length > 0) return server;
    }
  }
  return null;
}

export async function resolveWhoisServer(
  tld: string,
  connectFn?: ConnectFn,
): Promise<string | null> {
  const cleanTld = tld.startsWith('.') ? tld.slice(1) : tld;

  const cachedEntry = cached.get(cleanTld);
  if (cachedEntry !== undefined && !isExpired(cachedEntry)) {
    return cachedEntry.server;
  }

  try {
    const raw = await queryIanaWhois(cleanTld, connectFn);
    const server = parseWhoisServer(raw);
    cached.set(cleanTld, { server: server ?? '', expiresAt: Date.now() + CACHE_TTL_MS });
    return server;
  } catch {
    cached.set(cleanTld, { server: '', expiresAt: Date.now() + CACHE_TTL_MS });
    return null;
  }
}

export function clearIanaCache(): void {
  cached.clear();
}
