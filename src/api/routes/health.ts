// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ProviderHealthCheck } from '../../providers/provider-health.js';
import type { MetricsCollector } from '../../app/metrics-collector.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';

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

export function createHealthRouter(
  healthCheck?: ProviderHealthCheck,
  metrics?: MetricsCollector,
  dnsProvider?: DnsProvider,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response): void => {
    const payload: Record<string, unknown> = {
      status: 'ok',
      uptime: process.uptime(),
      version: readVersion(),
      timestamp: new Date().toISOString(),
    };
    if (metrics) {
      payload.metrics = metrics.snapshot();
    }
    if (dnsProvider?.getHealthStatus) {
      const dnsHealth = dnsProvider.getHealthStatus();
      payload.dns = {
        healthy: dnsHealth.healthy,
        dnssecValid: dnsHealth.dnssecValid,
        quorumMet: dnsHealth.quorumMet,
        requiredHealthyHosts: dnsHealth.requiredHealthyHosts,
        quorumMode: dnsHealth.quorumMode,
        details: dnsHealth.details,
        hosts: dnsHealth.hosts,
      };
    }
    res.json(payload);
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
