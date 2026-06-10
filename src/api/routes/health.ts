import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ProviderHealthCheck } from '../../providers/provider-health.js';

let cachedVersion: string | undefined;

function readVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export function createHealthRouter(healthCheck?: ProviderHealthCheck): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      version: readVersion(),
      timestamp: new Date().toISOString(),
    });
  });

  if (healthCheck) {
    router.get('/providers', (_req: Request, res: Response, next: NextFunction): void => {
      healthCheck
        .checkAll()
        .then((providers) => {
          const allOk = providers.every((p) => p.status === 'ok');
          res.json({
            status: allOk ? 'ok' : 'degraded',
            providers,
            timestamp: new Date().toISOString(),
          });
        })
        .catch(next);
    });
  }

  return router;
}
