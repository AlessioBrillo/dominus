#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The CLI entry point.
//
// It is a wrapper on purpose. The log destination has to be decided BEFORE
// the first module that captures a logger is imported: several modules
// take their logger at import time (`const logger = getLogger()`), so a
// destination decided inside the application would arrive too late for
// them and half the log lines would land on stdout, where the command's
// output lives.
//
// The wrapper sets the destination and then imports the application
// dynamically, so every logger in the process - the ones captured at
// import time and the ones taken later - writes to the same stream.
process.env.DOMINUS_LOG_DESTINATION = process.env.DOMINUS_LOG_DESTINATION ?? 'stderr';

await import('./cli-app.js');
