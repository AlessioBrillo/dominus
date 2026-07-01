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
