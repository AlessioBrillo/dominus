import type { Config } from '../config.js';
import { getLogger } from '../logger.js';

/**
 * Report the runtime status of every external provider.
 *
 * Each provider row shows: name, configured (yes/no), and a short note
 * about how missing configuration is handled. The shape is stable
 * across releases so the JSON output is safe for dashboards.
 */
export interface ProviderStatus {
  name: 'USPTO' | 'EUIPO' | 'KeywordPlanner' | 'NameBio' | 'GoogleAds' | 'WHOIS' | 'Registrar';
  configured: boolean;
  note: string;
}

export function reportProviderStatuses(config: Config): ProviderStatus[] {
  const euipoConfigured =
    config.EUIPO_CLIENT_ID !== undefined &&
    config.EUIPO_CLIENT_ID !== '' &&
    config.EUIPO_CLIENT_SECRET !== undefined &&
    config.EUIPO_CLIENT_SECRET !== '';

  return [
    {
      name: 'WHOIS',
      configured: true,
      note: `Node.js port-43 client, ${config.WHOIS_LOOKUP_TIMEOUT}ms timeout. TLD map + IANA fallback for unknown TLDs.`,
    },
    {
      name: 'USPTO',
      configured: true,
      note: `Public TSDR endpoint ${config.USPTO_SEARCH_URL} (no key required).`,
    },
    {
      name: 'EUIPO',
      configured: euipoConfigured,
      note: euipoConfigured
        ? `OAuth2 client ${config.EUIPO_CLIENT_ID?.slice(0, 6)}… against ${config.EUIPO_AUTH_URL}.`
        : 'EUIPO_CLIENT_ID and EUIPO_CLIENT_SECRET are missing — the EUIPO source will be marked Unverified on every gate run (graceful degrade).',
    },
    {
      name: 'KeywordPlanner',
      configured: config.KEYWORD_DATA_PATH !== undefined && config.KEYWORD_DATA_PATH !== '',
      note:
        config.KEYWORD_DATA_PATH !== undefined && config.KEYWORD_DATA_PATH !== ''
          ? `Manual file at ${config.KEYWORD_DATA_PATH}.`
          : config.GOOGLE_ADS_CLIENT_ID !== undefined && config.GOOGLE_ADS_CLIENT_ID !== ''
            ? 'Google Ads API configured (KEYWORD_PROVIDER=google-ads).'
            : 'KEYWORD_DATA_PATH and GOOGLE_ADS_CLIENT_ID are unset — commercial-signal search volume and CPC will be zero.',
    },
    {
      name: 'GoogleAds',
      configured:
        config.GOOGLE_ADS_CLIENT_ID !== undefined &&
        config.GOOGLE_ADS_CLIENT_ID !== '' &&
        config.GOOGLE_ADS_CLIENT_SECRET !== undefined &&
        config.GOOGLE_ADS_CLIENT_SECRET !== '' &&
        config.GOOGLE_ADS_REFRESH_TOKEN !== undefined &&
        config.GOOGLE_ADS_REFRESH_TOKEN !== '' &&
        config.GOOGLE_ADS_DEVELOPER_TOKEN !== undefined &&
        config.GOOGLE_ADS_DEVELOPER_TOKEN !== '' &&
        config.GOOGLE_ADS_CUSTOMER_ID !== undefined &&
        config.GOOGLE_ADS_CUSTOMER_ID !== '',
      note:
        config.GOOGLE_ADS_CLIENT_ID !== undefined && config.GOOGLE_ADS_CLIENT_ID !== ''
          ? `OAuth2 client ${config.GOOGLE_ADS_CLIENT_ID.slice(0, 6)}… against Google Ads API.`
          : 'GOOGLE_ADS_CLIENT_ID and related credentials are missing — the commercial signal will return zero volume (graceful degrade).',
    },
    {
      name: 'NameBio',
      configured: config.NAMEBIO_API_KEY !== undefined && config.NAMEBIO_API_KEY !== '',
      note:
        config.NAMEBIO_API_KEY !== undefined && config.NAMEBIO_API_KEY !== ''
          ? `Live API (namebio.com) with key ${config.NAMEBIO_API_KEY.slice(0, 6)}…`
          : config.COMPS_DATA_PATH !== undefined && config.COMPS_DATA_PATH !== ''
            ? `Manual CSV at ${config.COMPS_DATA_PATH}.`
            : 'NAMEBIO_API_KEY and COMPS_DATA_PATH are unset — the market signal will produce zero comparables.',
    },
    {
      name: 'Registrar',
      configured: config.REGISTRAR_PROVIDER !== 'manual',
      note:
        config.REGISTRAR_PROVIDER !== 'manual'
          ? `Active provider: ${config.REGISTRAR_PROVIDER}.`
          : 'REGISTRAR_PROVIDER is unset or set to "manual" — use `dominus registrars list` to see available providers.',
    },
  ];
}

/**
 * Emit a startup warning when EUIPO credentials are missing. Safe to
 * call from the composition root in both CLI and HTTP entrypoints.
 * No-op when credentials are present.
 *
 * `logger` is injected for testability; production code can call with
 * no argument and the default logger is used.
 */
export function warnCloudflareIfMissing(
  config: Config,
  logger: { warn: (msg: string) => void } = getLogger(),
): void {
  const cfConfigured =
    config.CLOUDFLARE_API_TOKEN !== undefined &&
    config.CLOUDFLARE_API_TOKEN !== '' &&
    config.CLOUDFLARE_ACCOUNT_ID !== undefined &&
    config.CLOUDFLARE_ACCOUNT_ID !== '';
  if (cfConfigured) return;

  logger.warn(
    'Cloudflare Registrar credentials are missing (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID). ' +
      'Registrar operations will use the manual (no-op) provider. ' +
      'Run `dominus providers status` for details.',
  );
}

export function warnEuipoIfMissing(
  config: Config,
  logger: { warn: (msg: string) => void } = getLogger(),
): void {
  const euipoConfigured =
    config.EUIPO_CLIENT_ID !== undefined &&
    config.EUIPO_CLIENT_ID !== '' &&
    config.EUIPO_CLIENT_SECRET !== undefined &&
    config.EUIPO_CLIENT_SECRET !== '';
  if (euipoConfigured) return;

  logger.warn(
    'EUIPO credentials are missing (EUIPO_CLIENT_ID / EUIPO_CLIENT_SECRET). The EUIPO source will be marked Unverified on every gate run. Run `dominus providers status` for details.',
  );
}
