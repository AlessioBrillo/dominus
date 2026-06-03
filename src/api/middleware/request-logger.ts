import type { Request, Response, NextFunction } from 'express';
import type pino from 'pino';

export function createRequestLogger(
  logger: pino.Logger,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        method: req.method,
        url: req.url,
        status: res.statusCode,
        durationMs: Date.now() - start,
      }, 'http request');
    });
    next();
  };
}
