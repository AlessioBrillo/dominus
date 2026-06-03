import pino from 'pino';
import { loadConfig } from './config.js';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger !== null) return _logger;

  const config = loadConfig();

  const options: pino.LoggerOptions = { level: config.LOG_LEVEL };
  if (config.LOG_PRETTY) {
    options.transport = { target: 'pino-pretty', options: { colorize: true } };
  }

  _logger = pino(options);

  return _logger;
}

export function resetLogger(): void {
  _logger = null;
}
