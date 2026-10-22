// SPDX-License-Identifier: AGPL-3.0-only
import pino from 'pino';
import { loadConfig } from './config.js';
import { requestStorage } from './api/middleware/request-context.js';

/**
 * Where the log stream goes.
 *
 * `stdout` is the server default: a container's log stream is stdout, and
 * the collectors read it there.
 *
 * `stderr` is the CLI default: a command's stdout is its OUTPUT channel.
 * A user who pipes `dominus score example.com` into `jq` must get the
 * decision and nothing else, and a script that reads the output must not
 * have to strip JSON log lines out of it. The logs still exist, on the
 * channel that is meant for them.
 */
export type LogDestination = 'stdout' | 'stderr';

/**
 * The destination the process starts with.
 *
 * The CLI entry point sets DOMINUS_LOG_DESTINATION=stderr before the
 * application is imported, so the modules that capture their logger at
 * import time write to the right stream too.
 */
function initialDestination(): LogDestination {
  return process.env.DOMINUS_LOG_DESTINATION === 'stderr' ? 'stderr' : 'stdout';
}

let _destination: LogDestination = initialDestination();
let _logger: pino.Logger | null = null;

/**
 * Select the log destination. Must be called before the first log line is
 * emitted, so the CLI calls it as its first statement.
 */
export function setLogDestination(destination: LogDestination): void {
  if (_destination === destination) return;
  _destination = destination;
  resetLogger();
}

/** The destination the logger currently writes to. */
export function getLogDestination(): LogDestination {
  return _destination;
}

export function getLogger(): pino.Logger {
  if (_logger !== null) return _logger;

  const config = loadConfig();

  const options: pino.LoggerOptions = { level: config.LOG_LEVEL };
  // Every log line emitted inside a request carries the correlation id, so a
  // support ticket quoting `X-Request-Id` selects exactly the lines that
  // belong to it - HTTP, services and providers alike. The mixin runs per log
  // call; reading AsyncLocalStorage costs nothing when there is no request in
  // flight (CLI, worker, scheduler), where the store is empty.
  options.mixin = (): Record<string, unknown> => {
    const requestId = requestStorage.getStore()?.requestId;
    return requestId === undefined ? {} : { requestId };
  };

  // fd 1 for the server, fd 2 for the CLI. A command writes its result to
  // stdout; everything else is diagnostics and belongs on stderr.
  const fd = _destination === 'stderr' ? 2 : 1;
  // A human at a terminal reads the logs, so they are pretty-printed there.
  // A script (or a pipe) reads the machine format. An explicit
  // LOG_PRETTY=false always wins: the operator asked for the JSON format.
  const explicitlyDisabled = process.env.LOG_PRETTY === 'false';
  const pretty =
    config.LOG_PRETTY ||
    (_destination === 'stderr' && process.stderr.isTTY === true && !explicitlyDisabled);
  if (pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, destination: fd },
    };
    _logger = pino(options);
    return _logger;
  }

  // The server writes to stdout the way it always did: pino's default
  // stream is process.stdout, so a consumer that reads the container's
  // output (and a test that intercepts process.stdout.write) sees exactly
  // the same bytes as before.
  //
  // The CLI writes to stderr through an explicit, synchronous destination:
  // a one-shot command exits immediately after its last log line, and an
  // asynchronous destination would lose it.
  if (_destination === 'stderr') {
    _logger = pino(options, pino.destination({ fd: 2, sync: true }));
    return _logger;
  }
  _logger = pino(options);
  return _logger;
}

export function resetLogger(): void {
  _logger = null;
}
