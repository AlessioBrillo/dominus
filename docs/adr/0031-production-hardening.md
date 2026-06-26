# ADR-0031: Production Hardening — CSP, Auth DI, Rate Limiting, Retry Consolidation

**Status**: Accepted

**Date**: 2026-06-26

**Deciders**: Alessio Brillo

**Technical Story**: The codebase accumulated four cross-cutting quality gaps during rapid feature development: (1) CSP allowed `'unsafe-inline'` on scripts despite the SPA bundling all JS, (2) `AuthProvider` was constructed with `new` outside the composition root, (3) per-IP rate limiting applied uniformly regardless of authentication state, and (4) three RetryingXxxProvider classes duplicated the same retry-with-circuit-breaker loop.

## Context and Problem Statement

DOMINUS grew from a single-user CLI tool to an open-source SaaS with a React SPA, Express API, and 18 CLI commands. Four architectural debts became blockers for production readiness:

1. **CSP**: `script-src 'self' 'unsafe-inline'` prevented the CSP from mitigating XSS. The SPA (Vite) bundles all JS into hashed assets served from `self`, so `'unsafe-inline'` on scripts was cargo-culted from the initial Express app setup.

2. **AuthProvider injection**: `EnvApiKeyProvider` was constructed with `new EnvApiKeyProvider(...)` in `src/index.ts`, bypassing the composition root (`createDependencies()`). This made it impossible to swap providers for tests or introduce multi-tenancy auth later.

3. **Rate limiting**: A single global `express-rate-limit` middleware covered all routes. Auth endpoints had no separate limit, and authenticated API calls had no per-token limit — one user could exhaust the global quota.

4. **Retry duplication**: `RetryingWhoisProvider`, `RetryingTrademarkProvider`, and `RetryingRdapProvider` each implemented an identical retry-with-circuit-breaker loop (~50 lines each). A separate `RetryPolicy` interface existed in both `retry-policy.ts` and `retryable-provider.ts` with different defaults.

## Decision Drivers

- **Security**: CSP `script-src` must reflect actual deployment architecture
- **Maintainability**: One retry path, not three
- **DI consistency**: All providers built in the composition root
- **Defense in depth**: Rate limiting per auth state, not a single blanket limit
- **Backward compatibility**: No breaking API changes, no config changes

## Considered Options

### CSP
- **Option A**: Remove `'unsafe-inline'` from `script-src` only (chosen)
- **Option B**: Remove from both `script-src` and `style-src`
- **Option C**: Nonce-based CSP for scripts

### AuthProvider injection
- **Option A**: Add `authProvider` to `DominusDependencies`, build in `createDependencies()` (chosen)
- **Option B**: Keep `new` in `src/index.ts` but pass through deps object
- **Option C**: Use a global singleton

### Retry consolidation
- **Option A**: Extract `withRetryAndCircuitBreaker()` utility, delegate from all three providers (chosen)
- **Option B**: Mixin pattern
- **Option C**: AOP decorator

## Decision Outcome

### CSP
**Chosen: Remove `'unsafe-inline'` from `script-src` only.**
Keep `'unsafe-inline'` on `style-src` for server-rendered public score pages. The SPA + Vite produces zero inline scripts — all JS is bundled into `assets/index-<hash>.js`. The JSON-LD blocks use `type="application/ld+json"` which is not executable JS.

**Positive consequences**:
- CSP now blocks all inline script injection
- No build changes needed (Vite handles hashing automatically)
- style-src continues to work for server-rendered pages

**Negative consequences**:
- TODOs for v0.7.0: remove `style-src 'unsafe-inline'` by externalizing CSS for public pages
- Server-rendered pages won't work with a fully locked-down CSP until v0.7.0

### AuthProvider injection
**Chosen: Add `authProvider` to `DominusDependencies`, build in `createDependencies()`.**
The `isActive` property is promoted to the `AuthProvider` interface so the auth middleware can use it without an unsafe type cast.

**Positive consequences**:
- Consistent with all other provider construction
- Enables test injection of mock auth providers
- Composable with JWT auth provider in v0.7.0

**Negative consequences**:
- None

### Rate limiting
**Chosen: Three-tier rate limiting.**
1. Auth endpoint: 30 req/60s (stricter, per-IP)
2. Global API: 100 req/15min (unchanged, per-IP)
3. Authenticated routes: 2x global limit, per-token via `Authorization` header

**Positive consequences**:
- Brute-force protection on login without affecting legitimate API use
- One API key holder cannot exhaust the global quota
- Backward compatible (config defaults unchanged)

**Negative consequences**:
- Marginal complexity increase in `src/index.ts` (3 rate limiter instances instead of 1)

### Retry consolidation
**Chosen: Extract `withRetryAndCircuitBreaker()` in `src/providers/retry-utils.ts`.**
Move `CircuitBreaker` from `src/app/` to `src/providers/` (cross-cutting, not app-specific). Add `cooldownMs` getter. Simplify all three RetryingXxxProvider to thin wrappers.

**Positive consequences**:
- Single retry path to maintain, test, and tune
- Net -47 lines across 3 provider files
- Circuit breaker in the correct architectural layer

**Negative consequences**:
- Providers lose ability to customize per-attempt logging (now unified in utility)

### DnsProvider refactoring
**Chosen: Extract `DnsProvider` interface to own file, inject config via constructor.**
The `NodeDnsProvider.loadConfig()` calls at runtime for `DNS_LOOKUP_TIMEOUT_MS`, `DNS_LOOKUP_STRATEGY`, etc. are replaced by constructor option injection.

**Positive consequences**:
- Config loaded once at startup, not per-lookup
- No silent fallback to defaults if config is corrupted
- Consistent with all other provider interfaces in `src/providers/`

**Negative consequences**:
- None

## Confirmation

- `npm run typecheck` passes (both backend + frontend)
- `npm test`: 123 test files, 1091 tests pass, 16 skipped
- `npm run bench`: benchmarks execute with deterministic mocked providers
- CSP verified: `curl -I http://localhost:3000/api/health | grep content-security-policy` shows `script-src 'self'`

## References

- OWASP CSP Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
- Vite CSP Guide: https://vite.dev/guide/features#security
- express-rate-limit: https://express-rate-limit.mintlify.app/
- Vitest Benchmark: https://vitest.dev/guide/features.html#benchmark
