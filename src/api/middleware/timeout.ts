// SPDX-License-Identifier: AGPL-3.0-only
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function requestTimeout(ms: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = new AbortController();
    const target = req as unknown as Record<string, unknown>;
    // Node >= 21 defines IncomingMessage.prototype.signal as a getter-only
    // accessor, so a plain assignment throws in strict mode and every
    // request 500s at boot. The accessor is configurable, so shadow it
    // with an instance property — the req.signal contract holds on every
    // supported Node version (Node 20 has no prototype accessor at all).
    Object.defineProperty(target, 'signal', {
      value: controller.signal,
      configurable: true,
      enumerable: false,
      writable: true,
    });

    res.setTimeout(ms, () => {
      controller.abort();
      if (!(res as unknown as Record<string, unknown>).writableEnded) {
        res.status(408).json({
          error: { code: 'REQUEST_TIMEOUT', message: `Request timed out after ${ms}ms` },
        });
      }
    });

    next();
  };
}
