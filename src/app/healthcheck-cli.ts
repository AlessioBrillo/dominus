// SPDX-License-Identifier: AGPL-3.0-only
import http from 'node:http';
import { loadConfig } from '../config.js';
import { runHealthcheck } from './healthcheck.js';
import type { HttpGetFn } from './healthcheck.js';

const config = loadConfig();
runHealthcheck(http.get.bind(http) as HttpGetFn, String(config.PORT), config.HOST);
