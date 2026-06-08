import type http from 'node:http';
import type { IncomingMessage, ClientRequest } from 'node:http';

export interface HttpGetFn {
  (
    url: string | URL,
    options: http.RequestOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest;
}

export function runHealthcheck(getFn: HttpGetFn, port: string, host: string): void {
  const path = '/api/health';
  const req = getFn(`http://${host}:${port}${path}`, { timeout: 5000 }, (res) => {
    if (res.statusCode === 200) {
      process.exit(0);
    }
    process.exit(1);
  });

  req.on('error', () => {
    process.exit(1);
  });

  req.on('timeout', () => {
    req.destroy();
    process.exit(1);
  });
}
