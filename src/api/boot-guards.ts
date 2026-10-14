// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Boot-time configuration warnings for the API server.
 *
 * These live apart from `main()` in src/index.ts so the decisions can be
 * tested without booting a server: a startup guard can otherwise only be
 * observed by booting the app in the offending configuration and watching
 * what happens, which is exactly the situation it exists to prevent.
 *
 * Scope is deliberately narrow. The deployment-level guards — METRICS_TOKEN
 * in cloud mode, Redis required in cloud mode (composition-root.ts) — are
 * fatal and already implemented where the dependency is known. What was
 * missing is a warning for a setting that is merely *likely* wrong, where
 * aborting would be wrong: only the operator knows the proxy count.
 */

export type GuardSeverity = 'fatal' | 'warn';

export interface BootGuard {
  readonly code: string;
  readonly severity: GuardSeverity;
  readonly message: string;
}

/**
 * `TRUST_PROXY_DEPTH` decides whose `X-Forwarded-For` is believed, which in
 * turn decides the key every per-IP rate limit uses. Both directions fail
 * silently rather than loudly:
 *
 * - too high: the limit keys on the client, which is right, but a
 *   client-supplied header becomes trusted — one caller can rotate the value
 *   and exhaust the limit without ever being throttled.
 * - too low (or unset behind a proxy): the limit keys on the proxy, so every
 *   client shares one bucket and all of them get throttled together.
 *
 * A configured-but-wrong value is the operator's judgement call — the
 * correct number depends on the proxy count, which only they know — so this
 * is a warning. Unset is worth flagging because it is the common accident:
 * the config default is 0, which reads as "no proxy" rather than "not
 * configured", so nothing surfaces it.
 *
 * Note this does not make the limiter itself distributed. With multiple app
 * replicas the per-IP and per-token counters on the protected router remain
 * in-process regardless of TRUST_PROXY_DEPTH; Redis covers the public router
 * only (ADR-0041/0052). Closing that needs a shared store on the protected
 * router, which is a change to the limiter, not to this setting.
 */
export function checkTrustProxyGuard(configured: number | null): BootGuard | null {
  if (configured !== null) return null;

  return {
    code: 'TRUST_PROXY_UNSET',
    severity: 'warn',
    message:
      'TRUST_PROXY_DEPTH is unset, so req.ip falls back to the socket address. If a reverse proxy ' +
      'terminates the connection, every per-IP rate limit keys on the proxy and throttles all ' +
      'clients as one. Set TRUST_PROXY_DEPTH to the number of proxy hops. The limiter remains ' +
      'in-process per replica, so a multi-instance deployment also needs a global throttle ' +
      'enforced at the proxy or a shared store on the protected router.',
  };
}
