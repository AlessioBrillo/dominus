import type { Request, Response, NextFunction } from 'express';

export function requestTimeout(ms: number) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setTimeout(ms, () => {
      res.status(408).json({
        error: { code: 'REQUEST_TIMEOUT', message: `Request timed out after ${ms}ms` },
      });
    });
    next();
  };
}
