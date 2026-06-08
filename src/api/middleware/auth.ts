import type { Request, Response, NextFunction } from 'express';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export function createAuthMiddleware(provider: AuthProvider) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing Authorization header. Use: Authorization: Bearer <api-key>',
        },
      });
      return;
    }

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !match[1]) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid Authorization format. Use: Authorization: Bearer <api-key>',
        },
      });
      return;
    }

    const apiKey = match[1];
    const result = await provider.validate(apiKey);

    if (!result.authenticated) {
      logger.warn({ ip: req.ip }, 'Authentication failed');
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Invalid API key' },
      });
      return;
    }

    next();
  };
}
