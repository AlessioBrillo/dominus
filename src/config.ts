import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from './types/errors.js';

const configSchema = z.object({
  DATABASE_PATH: z.string().min(1).default('./data/dominus.db'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  LOG_PRETTY: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  SCORING_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  DROP_SCORE_THRESHOLD: z.coerce.number().min(0).max(100).default(25),
  DROP_RENEWAL_HORIZON_DAYS: z.coerce.number().int().min(1).default(60),
  /**
   * Optional path to a JSON file produced from Google Keyword Planner export.
   * Format: array of { term, monthlySearchVolume, cpc, competition }.
   * When absent, ManualKeywordProvider returns zero-volume for all terms.
   */
  KEYWORD_DATA_PATH: z.string().optional(),
  /**
   * Optional path to a CSV file of NameBio comparable sales.
   * Columns: domain,price,date,venue
   * When absent, ManualCompsProvider returns no comparables.
   */
  COMPS_DATA_PATH: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config !== null) return _config;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  _config = result.data;
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
