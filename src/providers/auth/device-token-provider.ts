// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { AuthProvider, AuthResult, KeyManager } from './auth-provider.js';
import type { MobileDeviceRepository } from '../../db/repositories/mobile-device-repository.js';

/** Prefix that marks a mobile device token, so the provider can fail fast. */
export const DEVICE_TOKEN_PREFIX = 'dominus_device_';

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Validates revocable per-device credentials (ADR-0116).
 *
 * The member is placed FIRST in the composite provider: a device token has a
 * distinctive prefix, so the check is a single indexed lookup and cannot be
 * confused with an API key. The token identifies its own tenant; the lookup
 * therefore runs before a tenant context exists, like `api_keys`.
 */
export class DeviceTokenProvider implements AuthProvider {
  readonly name = 'DeviceTokenProvider';
  readonly supportsKeyManagement = false;

  constructor(private readonly repo: MobileDeviceRepository) {}

  get isActive(): boolean {
    return true;
  }

  asKeyManager(): KeyManager | undefined {
    return undefined;
  }

  async validate(token: string): Promise<AuthResult> {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return { authenticated: false };

    const row = await this.repo.findActiveByTokenHash(hashDeviceToken(token));
    if (row === null) return { authenticated: false };

    await this.repo.touch(row.id);
    return {
      authenticated: true,
      keyName: `device:${row.label}`,
      keyId: row.id,
      tenantId: row.tenant_id,
      // A installed app is a member credential, never an operator or an
      // admin one: it can appraise, track and acknowledge its own tenant's
      // data, but it cannot manage keys, seats or other tenants.
      role: 'member',
    };
  }
}
