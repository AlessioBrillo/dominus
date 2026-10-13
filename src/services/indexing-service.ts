// SPDX-License-Identifier: AGPL-3.0-only
import { getLogger } from '../logger.js';

const logger = getLogger();

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

export interface IndexNowSubmitResult {
  url: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

export interface IndexingServiceOptions {
  /** IndexNow key. When unset, submissions are refused (honest skip). */
  indexNowKey?: string | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Search-engine indexing via the IndexNow protocol (ADR-0083, M2).
 *
 * IndexNow is a free, key-based submission API honoured by Bing, Yandex,
 * Seznam and others: the key is hosted as plain text at
 * `https://<host>/<key>.txt` and URLs are POSTed to the endpoint. It is
 * configured only when the operator provides a key — like every other
 * external dependency, nothing is declared before it can work (ADR-0082).
 */
export class IndexingService {
  readonly #key: string | undefined;
  readonly #fetchImpl: typeof fetch;

  constructor(options: IndexingServiceOptions = {}) {
    this.#key = options.indexNowKey;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  get isConfigured(): boolean {
    return this.#key !== undefined && this.#key.length >= 8;
  }

  /** Body of the `/<key>.txt` verification file, or null when unconfigured. */
  keyFileContent(): string | null {
    return this.isConfigured ? (this.#key as string) : null;
  }

  matchesKey(candidate: string): boolean {
    return this.isConfigured && candidate === this.#key;
  }

  async submitUrls(urls: string[], host: string): Promise<IndexNowSubmitResult[]> {
    if (!this.isConfigured) {
      return urls.map((url) => ({
        url,
        ok: false,
        status: null,
        error: 'indexnow_not_configured',
      }));
    }

    const key = this.#key as string;
    const body = JSON.stringify({
      host,
      key,
      keyLocation: `https://${host}/${key}.txt`,
      urlList: urls,
    });

    try {
      const response = await this.#fetchImpl(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
      });

      // 200 = accepted, 202 = accepted (pending). Anything else is a refusal.
      const ok = response.status === 200 || response.status === 202;
      const error = ok ? undefined : `indexnow_http_${response.status}`;
      if (!ok) {
        logger.warn(
          { host, status: response.status, urlCount: urls.length },
          'IndexingService: submission refused',
        );
      }
      return urls.map((url) => ({
        url,
        ok,
        status: response.status,
        ...(error !== undefined ? { error } : {}),
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { host, err: message, urlCount: urls.length },
        'IndexingService: submission failed',
      );
      return urls.map((url) => ({ url, ok: false, status: null, error: message }));
    }
  }
}
