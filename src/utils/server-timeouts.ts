// SPDX-License-Identifier: AGPL-3.0-only

export interface ServerTimeoutConfig {
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

// Keep-alive window above the common edge/load-balancer idle timeouts
// (Cloudflare ~60s, AWS ALB/ELB 60s, nginx default 75s) so idle connections
// are reused instead of being torn down at the edge.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

// Node closes a connection if request headers are not fully received within
// headersTimeout. It must stay above keepAliveTimeout, otherwise an idle
// keep-alive connection that starts sending headers just before the socket
// idle close can be reset prematurely (HTTP 431/408).
const HEADERS_TIMEOUT_GRACE_MS = 5_000;

// App-level request budget (middleware, src/api/middleware/timeout.ts) must
// stay below the socket-level request receive timeout; Node's default is 300s.
const REQUEST_TIMEOUT_FLOOR_MS = 30_000;

export function serverTimeoutConfig(requestTimeoutMs: number): ServerTimeoutConfig {
  return {
    keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS,
    headersTimeoutMs: KEEP_ALIVE_TIMEOUT_MS + HEADERS_TIMEOUT_GRACE_MS,
    requestTimeoutMs:
      requestTimeoutMs > 0 ? requestTimeoutMs + HEADERS_TIMEOUT_GRACE_MS : REQUEST_TIMEOUT_FLOOR_MS,
  };
}
