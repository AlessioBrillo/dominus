import { getLogger } from '../logger.js';

const logger = getLogger();

export enum ExpiryWindow {
  PreRelease = 'pre_release',
  Closeout = 'closeout',
  DropCatch = 'drop_catch',
}

export interface DomainExpiryInfo {
  domain: string;
  expiryDate: string;
  tld: string;
  registrar?: string;
}

export interface ExpiryWatcherConfig {
  preReleaseDays: number;
  closeoutDays: number;
  pollIntervalHours: number;
}

export const DEFAULT_EXPIRY_WATCHER_CONFIG: ExpiryWatcherConfig = {
  preReleaseDays: 30,
  closeoutDays: 7,
  pollIntervalHours: 6,
};

export type DomainExpiryCallback = (
  domain: string,
  window: ExpiryWindow,
  expiryDate: string,
) => void | Promise<void>;

/** Result of a single expiry check cycle. */
export interface ExpiryWatcherPollResult {
  checked: number;
  inWindow: number;
  notified: number;
  errors: number;
}

/**
 * Tracks domain expiry dates and computes which aftermarket window
 * each domain falls into: pre-release (T-30d), closeout (T-7d), or
 * drop-catch (T+0d). Fires configurable callbacks when a domain
 * enters a window so the caller can enqueue a pipeline run or send
 * a notification.
 *
 * Windows are based on days-until-expiry:
 *   expiry is in ≤30 days  → pre-release
 *   expiry is in ≤7 days   → closeout (superset of pre-release)
 *   expiry has passed      → drop-catch
 *
 * A domain in both pre-release AND closeout reports closeout
 * (the narrower window wins).
 */
export class ExpiryWatcher {
  readonly #entries: Map<string, DomainExpiryInfo> = new Map();
  readonly #notified: Map<string, Set<ExpiryWindow>> = new Map();
  readonly #config: ExpiryWatcherConfig;
  #onExpiry?: DomainExpiryCallback;

  constructor(config: Partial<ExpiryWatcherConfig> = {}) {
    this.#config = { ...DEFAULT_EXPIRY_WATCHER_CONFIG, ...config };
  }

  /** Register the callback fired when a domain enters an expiry window. */
  setOnExpiry(cb: DomainExpiryCallback): void {
    this.#onExpiry = cb;
  }

  /** Add or update a domain's expiry tracking entry. */
  set(info: DomainExpiryInfo): void {
    this.#entries.set(info.domain, info);
    if (!this.#notified.has(info.domain)) {
      this.#notified.set(info.domain, new Set());
    }
  }

  /** Remove a domain from tracking. */
  remove(domain: string): void {
    this.#entries.delete(domain);
    this.#notified.delete(domain);
  }

  /** Get the current window for a domain based on days until expiry. */
  getWindow(expiryDate: string): ExpiryWindow | null {
    const now = Date.now();
    const expiry = new Date(expiryDate).getTime();
    if (isNaN(expiry)) return null;

    const daysUntilExpiry = (expiry - now) / (1000 * 60 * 60 * 24);

    if (daysUntilExpiry <= 0) return ExpiryWindow.DropCatch;
    if (daysUntilExpiry <= this.#config.closeoutDays) return ExpiryWindow.Closeout;
    if (daysUntilExpiry <= this.#config.preReleaseDays) return ExpiryWindow.PreRelease;
    return null;
  }

  /** Check all tracked domains and fire callbacks for new window entries. */
  async poll(): Promise<ExpiryWatcherPollResult> {
    const result: ExpiryWatcherPollResult = { checked: 0, inWindow: 0, notified: 0, errors: 0 };

    for (const [domain, info] of this.#entries) {
      result.checked++;
      try {
        const window = this.getWindow(info.expiryDate);
        if (window === null) continue;

        result.inWindow++;
        const notified = this.#notified.get(domain);
        if (notified?.has(window)) continue;

        logger.info(
          {
            domain,
            window,
            expiryDate: info.expiryDate,
            daysUntilExpiry: daysUntil(info.expiryDate),
          },
          `ExpiryWatcher: domain entered ${window} window`,
        );

        notified?.add(window);
        result.notified++;

        if (this.#onExpiry) {
          await this.#onExpiry(domain, window, info.expiryDate);
        }
      } catch (err) {
        logger.error({ err, domain }, 'ExpiryWatcher: error checking domain window');
        result.errors++;
      }
    }

    return result;
  }

  /** Number of domains currently being tracked. */
  get size(): number {
    return this.#entries.size;
  }

  /** All tracked expiry info. */
  entries(): DomainExpiryInfo[] {
    return Array.from(this.#entries.values());
  }
}

function daysUntil(isoDate: string): number {
  const diff = new Date(isoDate).getTime() - Date.now();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}
