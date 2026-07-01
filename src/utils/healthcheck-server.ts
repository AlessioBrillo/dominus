import http from 'node:http';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface HealthcheckOptions {
  port: number;
  label: string;
  check: () => Promise<boolean>;
}

export function createHealthcheckServer(options: HealthcheckOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      try {
        const ok = await options.check();
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'text/plain' });
        res.end(ok ? 'OK' : 'FAIL');
      } catch {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('FAIL');
      }
    } else {
      res.writeHead(404).end();
    }
  });

  server.listen(options.port, '127.0.0.1', () => {
    logger.info({ port: options.port, label: options.label }, 'Healthcheck server started');
  });

  server.unref();

  return server;
}
