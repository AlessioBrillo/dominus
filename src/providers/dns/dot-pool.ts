// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_OUTSTANDING_PER_CONNECTION = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_STRIKE_THRESHOLD = 3;

/**
 * Build a minimal DNS query message (RFC 1035 section 4.1.1).
 * Uses a random 16-bit query ID per request to prevent cross-query
 * confusion when multiple queries are multiplexed on one connection.
 */
export function buildDnsQuery(domain: string, qtype: number): Buffer {
  const header = Buffer.alloc(12);
  // ID: random 16-bit — prevents response-spoofing by on-path attackers
  header.writeUInt16BE(randomBytes(2).readUInt16BE(0), 0);
  // Flags: standard query with recursion desired (0x0100)
  header.writeUInt16BE(0x0100, 2);
  // QDCOUNT: 1 question
  header.writeUInt16BE(1, 4);
  // ANCOUNT, NSCOUNT, ARCOUNT: 0
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const qname = encodeDnsName(domain);
  const question = Buffer.alloc(qname.length + 4);
  qname.copy(question, 0);
  question.writeUInt16BE(qtype, qname.length);
  // QCLASS: IN (1)
  question.writeUInt16BE(1, qname.length + 2);

  return Buffer.concat([header, question]);
}

function encodeDnsName(name: string): Buffer {
  const parts = name.split('.');
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const buf = Buffer.from(part, 'ascii');
    const len = Buffer.alloc(1);
    len[0] = buf.length;
    buffers.push(len, buf);
  }
  buffers.push(Buffer.from([0x00]));
  return Buffer.concat(buffers);
}

function recordTypeToQtype(type: string): number {
  switch (type) {
    case 'A':
      return 1;
    case 'AAAA':
      return 28;
    case 'CNAME':
      return 5;
    case 'MX':
      return 15;
    case 'NS':
      return 2;
    case 'SOA':
      return 6;
    default:
      return 1;
  }
}

/**
 * Validate that a DNS response header matches the expected query ID.
 * RFC 1035 section 4.1.1: bytes 0-1 contain the query ID which must
 * match the request ID to prevent response-spoofing and cross-query
 * confusion in concurrent TLS connections.
 */
export function validateDnsResponse(response: Buffer, expectedId: number): boolean {
  if (response.length < 12) return false;
  const responseId = response.readUInt16BE(0);
  return responseId === expectedId;
}

export interface DotPoolOptions {
  /** Host of the DoT server (RFC 7858). */
  readonly endpoint: string;
  /** TLS SNI / certificate hostname; defaults to endpoint. */
  readonly servername?: string;
  /** TCP port; defaults to 853. */
  readonly port?: number;
  /** Max parallel TLS connections to this endpoint; default 4. */
  readonly maxConnections?: number;
  /** Max queries in flight per connection; default 8. */
  readonly maxOutstandingPerConnection?: number;
  /** Close idle connections after this many ms; default 30s. */
  readonly idleTimeoutMs?: number;
  /** Destroy a connection after this many consecutive timeouts; default 3. */
  readonly timeoutStrikeThreshold?: number;
  /** Override TLS verification — tests only, never set in production. */
  readonly rejectUnauthorized?: boolean;
  /** CA certificate bundle — tests only. */
  readonly ca?: string;
}

interface PendingQuery {
  id: number;
  payload: Buffer;
  label: string;
  resolve: (resolved: boolean) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  /** Written to a connection (vs. still queued in the pool). */
  onWire: boolean;
  /** Promise already settled — guards double-settling. */
  settled: boolean;
}

type QueryOutcome = { kind: 'resolved' } | { kind: 'error'; code: string; message: string };

/** Classify a complete DNS response (RFC 1035 header, no length prefix). */
function classifyResponse(msg: Buffer): QueryOutcome {
  const flags = msg.readUInt16BE(2);
  const rcode = flags & 0x000f;
  const truncated = (flags & 0x0200) !== 0;
  const ancount = msg.readUInt16BE(6);

  if (rcode === 3) return { kind: 'error', code: 'ENOTFOUND', message: 'DoT NXDOMAIN' };
  if (rcode !== 0) return { kind: 'error', code: 'ESERVFAIL', message: `DoT RCODE ${rcode}` };
  // A truncated response with no answers is not a definitive NODATA — the
  // answer may have been cut off. Conservative: treat as unknown, never as
  // available. A truncated response WITH answers still proves the domain
  // resolves, so it is accepted below.
  if (truncated && ancount === 0) {
    return { kind: 'error', code: 'ETRUNCATED', message: 'DoT truncated response' };
  }
  if (ancount === 0) return { kind: 'error', code: 'ENODATA', message: 'DoT NODATA' };
  return { kind: 'resolved' };
}

function timeoutError(label: string): Error {
  const err = new Error(`DoT lookup timed out for ${label}`);
  (err as { code?: string }).code = 'ETIMEOUT';
  return err;
}

/**
 * RFC 7766 connection pool for DNS-over-TLS.
 *
 * Reuses TLS connections across queries and multiplexes multiple
 * outstanding queries per connection, correlating responses by the
 * random 16-bit query ID. Previously every DoT query opened its own
 * TLS socket, making bulk scans handshake-bound (~1 RTT of setup per
 * query) instead of query-bound.
 *
 * The socket is a byte stream: messages are length-prefixed (RFC 7858
 * section 3.3). Chunks are accumulated until a full message is framed,
 * so TCP fragmentation can never mis-parse a header. The old data
 * handler read flags/ANCOUNT at unprefixed offsets, which rejected
 * every response as a spoofing attempt.
 *
 * A query that times out or aborts is marked "ghost": its reply is
 * still in-band and gets dropped, keeping the stream aligned — the
 * connection is only destroyed when the server looks hung (repeated
 * timeouts) or the socket errors/closes.
 */
export class DotPool {
  readonly endpoint: string;
  readonly maxConnections: number;
  readonly maxOutstandingPerConnection: number;
  readonly timeoutStrikeThreshold: number;
  readonly #servername: string | undefined;
  readonly #port: number;
  readonly idleTimeoutMs: number;
  readonly #rejectUnauthorized: boolean;
  readonly #ca: string | undefined;
  readonly #connections: DotPoolConnection[] = [];
  readonly #queue: PendingQuery[] = [];
  #closed = false;

  constructor(options: DotPoolOptions) {
    this.endpoint = options.endpoint;
    this.#servername = options.servername;
    this.#port = options.port ?? 853;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxOutstandingPerConnection =
      options.maxOutstandingPerConnection ?? DEFAULT_MAX_OUTSTANDING_PER_CONNECTION;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.timeoutStrikeThreshold =
      options.timeoutStrikeThreshold ?? DEFAULT_TIMEOUT_STRIKE_THRESHOLD;
    this.#rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.#ca = options.ca;
  }

  /**
   * Send a DNS query over TLS. Resolves true when the domain has at
   * least one answer record for the requested type. Rejects with a
   * `code` on the error for ENOTFOUND/ENODATA/ETRUNCATED/ETIMEOUT.
   */
  query(
    domain: string,
    recordType: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const wire = buildDnsQuery(domain, recordTypeToQtype(recordType));
    const payload = Buffer.alloc(2 + wire.length);
    payload.writeUInt16BE(wire.length, 0);
    wire.copy(payload, 2);

    return new Promise<boolean>((resolve, reject) => {
      const pending: PendingQuery = {
        id: wire.readUInt16BE(0),
        payload,
        label: `${domain} ${recordType}`,
        resolve,
        reject,
        timer: setTimeout(() => this.#onTimeout(pending), timeoutMs),
        signal,
        onAbort: (): void => {},
        onWire: false,
        settled: false,
      };
      pending.onAbort = (): void => this.#onAbort(pending);

      if (signal?.aborted) {
        clearTimeout(pending.timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', pending.onAbort, { once: true });
      // Double-check: the signal may have aborted between the check and
      // the listener registration (the abort event would not re-fire).
      if (signal?.aborted) {
        signal.removeEventListener('abort', pending.onAbort);
        clearTimeout(pending.timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      this.#enqueue(pending);
    });
  }

  /** Destroy all connections and reject queued queries. */
  close(): void {
    this.#closed = true;
    for (const conn of [...this.#connections]) {
      conn.destroy(new Error('DoT pool closed'));
    }
    this.#connections.length = 0;
    const queued = this.#queue.splice(0);
    for (const pending of queued) {
      this.settle(pending, { ok: false, err: new Error('DoT pool closed') });
    }
  }

  #enqueue(pending: PendingQuery): void {
    if (pending.settled) return;
    const conn = this.#pickConnection();
    if (conn !== undefined) {
      conn.send(pending);
      return;
    }
    this.#queue.push(pending);
  }

  #pickConnection(): DotPoolConnection | undefined {
    const usable = this.#connections.find((c) => c.alive && c.capacity > 0);
    if (usable !== undefined) return usable;
    if (this.#connections.length < this.maxConnections) {
      const conn = new DotPoolConnection(this, this.#tlsOptions());
      this.#connections.push(conn);
      return conn;
    }
    return undefined;
  }

  #tlsOptions(): ConnectionOptions {
    return {
      host: this.endpoint,
      port: this.#port,
      servername: this.#servername ?? this.endpoint,
      rejectUnauthorized: this.#rejectUnauthorized,
      ...(this.#ca !== undefined ? { ca: this.#ca } : {}),
    };
  }

  /** Reject a queued query that timed out before being sent. */
  #onTimeout(pending: PendingQuery): void {
    if (pending.settled) return;
    if (pending.onWire) {
      const conn = this.#connections.find((c) => c.hasQuery(pending.id));
      // A settled/removed query with a stale timer — nothing to do.
      if (conn === undefined) return;
      conn.onQueryTimeout(pending);
      return;
    }
    const idx = this.#queue.indexOf(pending);
    if (idx !== -1) this.#queue.splice(idx, 1);
    this.settle(pending, { ok: false, err: timeoutError(pending.label) });
  }

  /** Reject a query whose caller aborted; its reply is dropped in-band. */
  #onAbort(pending: PendingQuery): void {
    if (pending.settled) return;
    if (pending.onWire) {
      const conn = this.#connections.find((c) => c.hasQuery(pending.id));
      if (conn === undefined) return;
      conn.onQueryAbort(pending);
      return;
    }
    const idx = this.#queue.indexOf(pending);
    if (idx !== -1) this.#queue.splice(idx, 1);
    this.settle(pending, { ok: false, err: new DOMException('Aborted', 'AbortError') });
  }

  /** Finalize a pending query; idempotent. */
  /** Internal: finalize a pending query (idempotent). */
  settle(
    pending: PendingQuery,
    outcome: { ok: true; value: boolean } | { ok: false; err: Error },
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    if (outcome.ok) {
      pending.resolve(outcome.value);
    } else {
      pending.reject(outcome.err);
    }
    this.#pump();
  }

  /** Move queued queries onto connections as capacity frees up. */
  #pump(): void {
    if (this.#closed) return;
    while (this.#queue.length > 0) {
      const conn = this.#pickConnection();
      if (conn === undefined) return;
      const pending = this.#queue.shift();
      if (pending === undefined) return;
      conn.send(pending);
    }
  }

  forgetConnection(conn: DotPoolConnection): void {
    const idx = this.#connections.indexOf(conn);
    if (idx !== -1) this.#connections.splice(idx, 1);
  }
}

/**
 * One TCP+TLS connection to a DoT endpoint with length-prefixed message
 * framing (RFC 7858) and multiple outstanding queries correlated by ID.
 */
class DotPoolConnection {
  readonly #pool: DotPool;
  readonly #tlsOptions: ConnectionOptions;
  #socket: TLSSocket | undefined;
  #buffer: Buffer = Buffer.alloc(0);
  #outstanding = new Map<number, PendingQuery>();
  #strikes = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  alive = false;

  constructor(pool: DotPool, tlsOptions: ConnectionOptions) {
    this.#pool = pool;
    this.#tlsOptions = tlsOptions;
  }

  get capacity(): number {
    return this.#pool.maxOutstandingPerConnection - this.#outstanding.size;
  }

  hasQuery(id: number): boolean {
    return this.#outstanding.has(id);
  }

  send(pending: PendingQuery): void {
    if (pending.settled) return;
    if (!this.alive) this.#connect();
    this.#outstanding.set(pending.id, pending);
    pending.onWire = true;
    this.#clearIdleTimer();
    // Backpressure ignored: payloads are tiny; Node buffers the write.
    this.#socket?.write(pending.payload);
  }

  onQueryTimeout(pending: PendingQuery): void {
    if (pending.settled) return;
    this.#strikes++;
    if (this.#strikes >= this.#pool.timeoutStrikeThreshold) {
      // The server looks hung — destroy settles every outstanding query,
      // including this one, and a fresh connection replaces this one.
      this.destroy(
        new Error(`DoT: ${this.#strikes} consecutive timeouts on ${this.#pool.endpoint}`),
      );
      return;
    }
    // The reply is still in-band — drop it when it arrives (stream stays
    // aligned) rather than destroying the connection.
    this.#outstanding.delete(pending.id);
    this.#pool.settle(pending, { ok: false, err: timeoutError(pending.label) });
  }

  onQueryAbort(pending: PendingQuery): void {
    if (pending.settled) return;
    this.#outstanding.delete(pending.id);
    this.#pool.settle(pending, { ok: false, err: new DOMException('Aborted', 'AbortError') });
  }

  destroy(err: Error): void {
    if (!this.alive && this.#outstanding.size === 0) return;
    this.alive = false;
    this.#clearIdleTimer();
    const pending = [...this.#outstanding.values()];
    this.#outstanding.clear();
    for (const p of pending) {
      this.#pool.settle(p, { ok: false, err });
    }
    this.#socket?.destroy();
    this.#pool.forgetConnection(this);
  }

  #connect(): void {
    const socket = tlsConnect(this.#tlsOptions);
    socket.setNoDelay(true);
    this.#socket = socket;
    this.alive = true;
    socket.on('connect', () => {
      this.#strikes = 0;
    });
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', (err: Error) => {
      logger.warn({ err, endpoint: this.#pool.endpoint }, 'DoT connection error');
      this.destroy(new Error(`DoT connection error: ${err.message}`));
    });
    socket.on('close', () => this.#onClose());
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 2) {
      const length = this.#buffer.readUInt16BE(0);
      if (this.#buffer.length < 2 + length) break;
      const msg = this.#buffer.subarray(2, 2 + length);
      this.#buffer = this.#buffer.subarray(2 + length);
      if (msg.length < 12) {
        this.destroy(new Error('DoT: response too short'));
        return;
      }
      this.#onResponse(msg);
    }
  }

  #onResponse(msg: Buffer): void {
    const id = msg.readUInt16BE(0);
    const pending = this.#outstanding.get(id);
    // Stray (ID mismatch, already-ghosted) response — drop it, the stream
    // stays aligned.
    if (pending === undefined) return;
    this.#outstanding.delete(id);
    this.#strikes = 0;
    const outcome = classifyResponse(msg);
    if (outcome.kind === 'error') {
      const err = Object.assign(new Error(outcome.message), { code: outcome.code });
      this.#pool.settle(pending, { ok: false, err });
    } else {
      this.#pool.settle(pending, { ok: true, value: true });
    }
    this.#armIdleTimer();
  }

  #onClose(): void {
    this.alive = false;
    this.#clearIdleTimer();
    if (this.#outstanding.size > 0) {
      this.destroy(new Error('DoT connection closed unexpectedly'));
      return;
    }
    this.#pool.forgetConnection(this);
  }

  #armIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#outstanding.size > 0) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#outstanding.size === 0 && this.alive) {
        this.#socket?.end();
      }
    }, this.#pool.idleTimeoutMs);
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }
}
