import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function requestTimeout(ms: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = new AbortController();
    (req as unknown as Record<string, unknown>).signal = controller.signal;

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
