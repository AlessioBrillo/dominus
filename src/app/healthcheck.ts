import http from 'node:http';
import { env } from 'node:process';

const port = env['PORT'] ?? '3000';
const host = env['HOST'] ?? '127.0.0.1';
const path = '/api/health';

const req = http.get(`http://${host}:${port}${path}`, { timeout: 5000 }, (res) => {
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
