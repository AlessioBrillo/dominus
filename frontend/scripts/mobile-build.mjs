#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Build the store variant: prices and checkout are compiled out, and the API
// base URL is absolute because a bundled webview has no useful origin.
import { spawnSync } from 'node:child_process';

const apiUrl = process.env.MOBILE_API_URL ?? 'https://app.dominus.so';
const env = {
  ...process.env,
  VITE_APP_VARIANT: 'store',
  VITE_API_BASE_URL: apiUrl.replace(/\/$/, ''),
};

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['run', 'build']);
run('npx', ['cap', 'sync']);
