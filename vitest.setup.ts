import { afterEach } from 'vitest';
import { resetConfig } from './src/config.js';

afterEach(() => {
  resetConfig();
});
