// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Per-request context, propagated to every log line emitted while the
 * request is in flight.
 *
 * Why this exists: the API had no request identifier at all. With a
 * multi-tenant service and a published SLA, a support ticket could not be
 * traced back to a log line — the HTTP log line carried method/url/status
 * but nothing that ties it to the service logs emitted during the same
 * request. A correlation id is the cheapest way to close that gap, and it
 * is what an on-call responder asks for first.
 *
 * Contract:
 * - Correlation ids are accepted from clients that already have them
 *   (`X-Request-Id`), generated otherwise. Echoing the client's id lets a
 *   caller keep a single identifier across a retry.
 * - Inbound values are never trusted verbatim: an attacker-supplied id
 *   ends up in log lines and response headers, so length is capped and the
 *   character set is restricted. Anything else is replaced with a fresh
 *   UUID.
 * - The id is stored in AsyncLocalStorage rather than on `req` so that
 *   service code far below the HTTP layer can log it without an explicit
 *   parameter threaded through every call site.
 */
export interface RequestContext {
  /** Stable identifier for the lifetime of one request. */
  readonly requestId: string;
}

const REQUEST_ID_HEADER = 'X-Request-Id';

/** Max accepted length for a client-supplied id: long enough for real
 *  tracing systems (W3C traceparent is 55 chars), short enough to stay out
 *  of log storage. */
const MAX_REQUEST_ID_LENGTH = 200;

/** Header-injection and log-pollution guard: the id is echoed in a header
 *  and copied into log lines, so confine it to a printable token charset. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

export const requestStorage = new AsyncLocalStorage<RequestContext>();

/** Read the current request id, or `undefined` outside a request. */
export function getRequestId(): string | undefined {
  return requestStorage.getStore()?.requestId;
}

/**
 * Resolve the inbound `X-Request-Id`, or mint a new one.
 *
 * Exported for tests; application code goes through {@link requestContext}.
 */
export function resolveRequestId(inbound: unknown): string {
  if (typeof inbound === 'string') {
    const trimmed = inbound.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= MAX_REQUEST_ID_LENGTH &&
      SAFE_REQUEST_ID.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return randomUUID();
}

export function requestContext(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = resolveRequestId(req.headers['x-request-id']);
    const context: RequestContext = { requestId };

    res.setHeader(REQUEST_ID_HEADER, requestId);

    // `run` keeps the context alive across Express' async boundary, so a
    // `next()` that resolves later (or throws) still resolves to the right
    // id. Running the store explicitly rather than relying on the ambient
    // context also means the id is available synchronously in `finish`
    // callbacks, which fire outside the request context.
    requestStorage.run(context, () => {
      next();
    });
  };
}
