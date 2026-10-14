// SPDX-License-Identifier: AGPL-3.0-only
import pino from 'pino';
import { loadConfig } from './config.js';
import { requestStorage } from './api/middleware/request-context.js';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger !== null) return _logger;

  const config = loadConfig();

  const options: pino.LoggerOptions = { level: config.LOG_LEVEL };
  if (config.LOG_PRETTY) {
    options.transport = { target: 'pino-pretty', options: { colorize: true } };
  }
  // Every log line emitted inside a request carries the correlation id, so a
  // support ticket quoting `X-Request-Id` selects exactly the lines that
  // belong to it — HTTP, services and providers alike. The mixin runs per log
  // call; reading AsyncLocalStorage costs nothing when there is no request in
  // flight (CLI, worker, scheduler), where the store is empty.
  options.mixin = (): Record<string, unknown> => {
    const requestId = requestStorage.getStore()?.requestId;
    return requestId === undefined ? {} : { requestId };
  };

  _logger = pino(options);

  return _logger;
}

export function resetLogger(): void {
  _logger = null;
}
