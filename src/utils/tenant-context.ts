// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';

const tenantStorage = new AsyncLocalStorage<string>();

/**
 * Run a function within a tenant context. All async operations spawned
 * within `fn` inherit this tenant ID via AsyncLocalStorage propagation.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run(tenantId, fn);
}

/**
 * Create a scoped tenant context within an existing one. Useful for
 * background operations (workers, cron jobs) that need to perform
 * actions as a specific tenant while preserving the outer context.
 *
 * Unlike runWithTenant, this returns the tenant ID and the wrapped
 * function separately, allowing the caller to decide when to invoke.
 *
 * Usage:
 *   const { scoped, tenantId } = scopedTenant('tenant-abc');
 *   await scoped(() => db.query('SELECT ...'));
 */
export function scopedTenant<T>(tenantId: string): {
  scoped: (fn: () => T) => T;
  tenantId: string;
} {
  return {
    scoped: (fn: () => T) => tenantStorage.run(tenantId, fn),
    tenantId,
  };
}

/**
 * Return the tenant ID for the current async context, or `undefined`
 * when called outside a `runWithTenant()` scope (e.g. CLI commands,
 * worker startup, tests).
 */
export function getTenantId(): string | undefined {
  return tenantStorage.getStore();
}

/**
 * Resolve the effective tenant ID using the most specific source:
 * 1. Explicit `override` parameter (caller-provided)
 * 2. AsyncLocalStorage context (set by HTTP middleware)
 * 3. Fallback to `'default'` (community edition, single-tenant)
 */
export function resolveTenantId(override?: string): string {
  return override ?? getTenantId() ?? 'default';
}
