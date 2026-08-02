// SPDX-License-Identifier: AGPL-3.0-only
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { DotPool } from '../dot-pool.js';

// Self-signed cert generated at runtime with openssl (never committed, so
// secret scanners stay quiet). The suite is skipped when openssl is
// unavailable. The cert MUST be generated at module load: describe.runIf()
// evaluates the flag when the describe block is registered, so a cert
// generated in a later beforeAll that failed could never be skipped
// retroactively — the suite would run with empty key/cert and every TLS
// handshake would fail.
let hasOpenSSL: boolean;
let certDir = '';
let keyPem = '';
let certPem = '';

try {
  certDir = mkdtempSync(join(tmpdir(), 'dominus-dot-'));
  execSync(
    `"${resolveOpenSslBinary()}" req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem ` +
      '-days 1 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
    { cwd: certDir, stdio: 'ignore' },
  );
  keyPem = readFileSync(join(certDir, 'key.pem'), 'utf8');
  certPem = readFileSync(join(certDir, 'cert.pem'), 'utf8');
  hasOpenSSL = true;
} catch {
  hasOpenSSL = false;
}

/** Resolve an openssl binary: from PATH (Linux CI, git-bash) or common
 * Windows install locations (Git for Windows, official Win64 builds). */
function resolveOpenSslBinary(): string {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return 'openssl';
  } catch {
    // Fall through to well-known Windows paths.
  }
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  ];
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" version`, { stdio: 'ignore' });
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  throw new Error('openssl not found');
}

afterAll(() => {
  if (certDir !== '') rmSync(certDir, { recursive: true, force: true });
});

interface ServerContext {
  port: number;
  connections: { count: number };
  close: () => Promise<void>;
}

/** TLS server that frames length-prefixed DNS queries and calls the handler. */
function startServer(handler: (socket: TLSSocket, query: Buffer) => void): Promise<ServerContext> {
  return new Promise((resolve, reject) => {
    const connections = { count: 0 };
    const server = createTlsServer({ key: keyPem, cert: certPem }, (socket) => {
      connections.count++;
      let buffer: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const length = buffer.readUInt16BE(0);
          if (buffer.length < 2 + length) break;
          const query = buffer.subarray(2, 2 + length);
          buffer = buffer.subarray(2 + length);
          handler(socket, query);
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind test server'));
        return;
      }
      resolve({
        port: address.port,
        connections,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

/** Length-framed DNS response echoing the question, with N A answers. */
function buildResponse(
  query: Buffer,
  opts: { id?: number; rcode?: number; ancount?: number } = {},
): Buffer {
  const id = opts.id ?? query.readUInt16BE(0);
  const rcode = opts.rcode ?? 0;
  const ancount = opts.ancount ?? 1;
  const question = query.subarray(12);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(ancount, 6);
  const answers: Buffer[] = [];
  for (let i = 0; i < ancount; i++) {
    const answer = Buffer.alloc(16);
    answer.writeUInt16BE(0xc00c, 0); // pointer to qname
    answer.writeUInt16BE(1, 2); // type A
    answer.writeUInt16BE(1, 4); // class IN
    answer.writeUInt32BE(60, 6); // ttl
    answer.writeUInt16BE(4, 10); // rdlength
    Buffer.from([1, 2, 3, 4]).copy(answer, 12);
    answers.push(answer);
  }
  const dns = Buffer.concat([header, question, ...answers]);
  const framed = Buffer.alloc(2 + dns.length);
  framed.writeUInt16BE(dns.length, 0);
  dns.copy(framed, 2);
  return framed;
}

function parseQName(query: Buffer): string {
  const labels: string[] = [];
  let offset = 12;
  while (offset < query.length) {
    const len = query[offset];
    if (len === undefined || len === 0) break;
    labels.push(query.subarray(offset + 1, offset + 1 + len).toString('ascii'));
    offset += 1 + len;
  }
  return labels.join('.');
}

function makePool(port: number, extra: Record<string, number> = {}): DotPool {
  return new DotPool({
    endpoint: '127.0.0.1',
    port,
    servername: 'localhost',
    ca: certPem,
    rejectUnauthorized: true,
    ...extra,
  });
}

describe.runIf(hasOpenSSL)('DotPool (RFC 7766 over real TLS)', () => {
  it('reuses one TLS connection across sequential queries', async () => {
    const ctx = await startServer((socket, query) => socket.write(buildResponse(query)));
    const pool = makePool(ctx.port);
    try {
      await expect(pool.query('example.com', 'A', 2000)).resolves.toBe(true);
      await expect(pool.query('example.net', 'A', 2000)).resolves.toBe(true);
      await expect(pool.query('example.org', 'A', 2000)).resolves.toBe(true);
      expect(ctx.connections.count).toBe(1);
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('multiplexes concurrent queries on a single connection', async () => {
    const ctx = await startServer((socket, query) => socket.write(buildResponse(query)));
    const pool = makePool(ctx.port, {
      maxConnections: 1,
      maxOutstandingPerConnection: 32,
    });
    try {
      const domains = Array.from({ length: 12 }, (_, i) => `d${i}.com`);
      const results = await Promise.all(domains.map((d) => pool.query(d, 'A', 2000)));
      expect(results.every((r) => r === true)).toBe(true);
      expect(ctx.connections.count).toBe(1);
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('times out a hung query and opens a fresh connection', async () => {
    let answered = 0;
    const ctx = await startServer((socket, query) => {
      answered++;
      if (answered > 1) socket.write(buildResponse(query));
    });
    const pool = makePool(ctx.port, {
      timeoutStrikeThreshold: 1,
    });
    try {
      // Rejects (connection destroyed after the strike threshold) and a
      // fresh connection serves the next query.
      await expect(pool.query('hung.com', 'A', 60)).rejects.toThrow();
      await expect(pool.query('ok.com', 'A', 2000)).resolves.toBe(true);
      expect(ctx.connections.count).toBe(2);
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('parses a response split across TCP segments', async () => {
    const ctx = await startServer((socket, query) => {
      const framed = buildResponse(query);
      const half = Math.floor(framed.length / 2);
      socket.write(framed.subarray(0, half));
      setTimeout(() => socket.write(framed.subarray(half)), 20);
    });
    const pool = makePool(ctx.port);
    try {
      await expect(pool.query('frag.com', 'A', 2000)).resolves.toBe(true);
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('rejects NXDOMAIN with ENOTFOUND', async () => {
    const ctx = await startServer((socket, query) =>
      socket.write(buildResponse(query, { rcode: 3, ancount: 0 })),
    );
    const pool = makePool(ctx.port);
    try {
      await expect(pool.query('nx.com', 'A', 2000)).rejects.toMatchObject({ code: 'ENOTFOUND' });
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('rejects NODATA with ENODATA', async () => {
    const ctx = await startServer((socket, query) =>
      socket.write(buildResponse(query, { rcode: 0, ancount: 0 })),
    );
    const pool = makePool(ctx.port);
    try {
      await expect(pool.query('nodata.com', 'A', 2000)).rejects.toMatchObject({ code: 'ENODATA' });
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('treats a truncated response without answers as unknown, not NODATA', async () => {
    // TC flag (0x0200) with ANCOUNT=0: the answer may have been cut off —
    // this must never be interpreted as a definitive NODATA (which would
    // imply availability upstream).
    const ctx = await startServer((socket, query) => {
      const response = buildResponse(query, { rcode: 0, ancount: 0 });
      response.writeUInt16BE(0x8180 | 0x0200, 4);
      socket.write(response);
    });
    const pool = makePool(ctx.port);
    try {
      await expect(pool.query('tc.com', 'A', 2000)).rejects.toMatchObject({ code: 'ETRUNCATED' });
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('accepts a truncated response that still carries answers', async () => {
    // TC with ANCOUNT>0 still proves the domain resolves.
    const ctx = await startServer((socket, query) => {
      const response = buildResponse(query, { rcode: 0, ancount: 1 });
      response.writeUInt16BE(0x8180 | 0x0200, 4);
      socket.write(response);
    });
    const pool = makePool(ctx.port);
    try {
      await expect(pool.query('tc-answers.com', 'A', 2000)).resolves.toBe(true);
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('keeps the connection usable after a caller abort', async () => {
    let delayed = true;
    const ctx = await startServer((socket, query) => {
      if (delayed) {
        delayed = false;
        setTimeout(() => socket.write(buildResponse(query)), 120);
      } else {
        socket.write(buildResponse(query));
      }
    });
    const pool = makePool(ctx.port);
    try {
      const controller = new AbortController();
      const pending = pool.query('slow.com', 'A', 2000, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await expect(pool.query('fast.com', 'A', 2000)).resolves.toBe(true);
      expect(ctx.connections.count).toBe(1);
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('rejects queries past maxQueued with EQUEUEFULL', async () => {
    // A mute server keeps every outstanding query in flight, so the queue
    // fills and the third query must fail fast with EQUEUEFULL.
    const ctx = await startServer(() => {});
    const pool = makePool(ctx.port, {
      maxConnections: 1,
      maxOutstandingPerConnection: 1,
      maxQueued: 1,
    });
    try {
      const first = pool.query('q1.com', 'A', 2000);
      const second = pool.query('q2.com', 'A', 2000);
      await new Promise((r) => setTimeout(r, 50));
      await expect(pool.query('q3.com', 'A', 2000)).rejects.toMatchObject({ code: 'EQUEUEFULL' });
      pool.close();
      await expect(first).rejects.toThrow();
      await expect(second).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it('drops responses with an unexpected query ID and stays aligned', async () => {
    let wrong = true;
    const ctx = await startServer((socket, query) => {
      if (wrong) {
        wrong = false;
        socket.write(buildResponse(query, { id: query.readUInt16BE(0) + 1 }));
      } else {
        socket.write(buildResponse(query));
      }
    });
    const pool = makePool(ctx.port);
    try {
      await expect(pool.query('spoof.com', 'A', 60)).rejects.toMatchObject({ code: 'ETIMEOUT' });
      await expect(pool.query('ok.com', 'A', 2000)).resolves.toBe(true);
      expect(ctx.connections.count).toBe(1);
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('regenerates the query ID when the RNG collides with an in-flight query', async () => {
    let rngCalls = 0;
    const ctx = await startServer((socket, query) => {
      const name = parseQName(query);
      if (name === 'collide-nx.com') {
        socket.write(buildResponse(query, { rcode: 3, ancount: 0 }));
      } else {
        socket.write(buildResponse(query));
      }
    });
    const pool = new DotPool({
      endpoint: '127.0.0.1',
      port: ctx.port,
      servername: 'localhost',
      ca: certPem,
      rejectUnauthorized: true,
      maxConnections: 1,
      maxOutstandingPerConnection: 8,
      rng: (size: number): Buffer => {
        rngCalls++;
        const buf = Buffer.alloc(size);
        // First two draws collide on the same 16-bit ID, later draws diverge.
        buf.writeUInt16BE(rngCalls <= 2 ? 0x1234 : 0x5000 + rngCalls, 0);
        return buf;
      },
    });
    try {
      // The second query must NOT overwrite the first pending entry — both
      // queries must settle with their own response.
      const [nx, ok] = await Promise.allSettled([
        pool.query('collide-nx.com', 'A', 2000),
        pool.query('collide-ok.com', 'A', 2000),
      ]);
      expect(nx.status).toBe('rejected');
      expect((nx as PromiseRejectedResult).reason).toMatchObject({ code: 'ENOTFOUND' });
      expect(ok.status).toBe('fulfilled');
      expect((ok as PromiseFulfilledResult<boolean>).value).toBe(true);
    } finally {
      pool.close();
      await ctx.close();
    }
  });

  it('guarantees progress when the RNG is pathologically constant', async () => {
    const ctx = await startServer((socket, query) => socket.write(buildResponse(query)));
    const pool = new DotPool({
      endpoint: '127.0.0.1',
      port: ctx.port,
      servername: 'localhost',
      ca: certPem,
      rejectUnauthorized: true,
      maxConnections: 1,
      maxOutstandingPerConnection: 8,
      rng: (): Buffer => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(0x0001, 0);
        return buf;
      },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) => pool.query(`c${i}.com`, 'A', 2000)),
      );
      expect(results.every((r) => r === true)).toBe(true);
      expect(ctx.connections.count).toBe(1);
    } finally {
      pool.close();
      await ctx.close();
    }
  });
});
