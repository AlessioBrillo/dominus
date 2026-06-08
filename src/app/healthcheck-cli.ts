/**
 * Healthcheck CLI entry point — invoked by Docker HEALTHCHECK.
 * Separated from healthcheck.ts to keep the module side-effect-free
 * for testability.
 */
import http from 'node:http';
import { env } from 'node:process';
import { runHealthcheck } from './healthcheck.js';
import type { HttpGetFn } from './healthcheck.js';

const port = env['PORT'] ?? '3000';
const host = env['HOST'] ?? '127.0.0.1';
runHealthcheck(http.get.bind(http) as HttpGetFn, port, host);
