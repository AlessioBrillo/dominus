# ADR-0085: Tenant Credential Vault for Automated Provider Access

## Metadata

| Field          | Value                                                    |
| -------------- | -------------------------------------------------------- |
| **Status**     | Accepted                                                 |
| **Date**       | 2026-10-16                                               |
| **Authors**    | Alessio Brillo                                           |
| **Deciders**   | Alessio Brillo                                           |
| **Supersedes** | —                                                        |
| **Relates to** | ADR-0004, ADR-0082, ADR-0083, ADR-0084                  |
| **Project**    | DOMINUS                                                  |

## Context

ADR-0083/0084 established the post-acquisition automation pipeline
(`portfolio → site → indexing → dns → parking → listing`) behind kill
switches and dry-run defaults. Every step that spends money or talks to an
external provider on behalf of a SaaS tenant needs that tenant's own
credentials:

- Registrar API tokens for automatic purchase (Dynadot, Porkbun, Namecheap,
  OVH, GoDaddy, Cloudflare...)
- Parking provider API keys for revenue reporting and domain delegation
- Google AdSense / Google Search Console OAuth tokens for monetization and
  indexing
- Marketplace API keys for offer sync (when vendor APIs are verified)

Today every provider is configured from **operator-level env vars** (one
registrar for the whole deployment). A multi-tenant SaaS cannot automate
"for the tenant" without per-tenant credentials, stored safely and resolved
per request.

Storing plaintext credentials in the database is unacceptable. The vault
must encrypt at rest, never log or return plaintext, and degrade gracefully
when the encryption key is absent.

## Decision Drivers

1. **Zero plaintext at rest**: credentials are encrypted before INSERT and
   decrypted only in memory for the lifetime of a single provider call.
2. **Provider-agnostic**: one vault table holds credentials for any provider
   type (registrar, parking, adsense, gsc, marketplace). New providers add
   rows, not columns.
3. **Tenant isolation**: repository-enforced via `resolveTenantId()`, same
   pattern as `tenant_automation_settings` (0063) and
   `tenant_listing_settings` (0065).
4. **Operator brake**: the env-level `VAULT_ENCRYPTION_KEY` is the global
   gate. When unset, credential writes are refused (fail-closed) — no
   silent plaintext fallback. The community edition (single-tenant, env
   providers) is unaffected.
5. **ADR-0082 honesty**: no provider adapter is declared as working before
   its credentials can be verified against the real vendor API. The vault
   stores credentials; adapter verification is a separate milestone
   (M8b, M10, M12).

## Considered Options

### Option A: One column per provider on the tenant table

**Advantages:** simple schema, no new table.

**Disadvantages:** schema churn for every new provider; no audit trail of
credential rotation; cannot store provider-specific metadata (scopes,
refresh tokens, account IDs). Rejected.

### Option B: Separate table per provider type

**Advantages:** strong typing per provider.

**Disadvantages:** N tables for N providers; adding a parking provider
means a migration; repository per provider. Rejected.

### Option C: Single `tenant_credentials` table with provider type + encrypted blob (chosen)

**Advantages:** one table, one repository, provider-agnostic; rotation
audited via `updated_at` and `automation_audit`; plaintext never
persisted.

**Disadvantages:** decryption happens in application code; key management
is the operator's responsibility (VAULT_ENCRYPTION_KEY). Mitigated by
scrypt key derivation and AES-GCM authenticated encryption.

## Decision

1. **`tenant_credentials` table** (migration 0066): one row per
   `(tenant_id, provider_type, provider_name)`. Columns:
   `encrypted_credential` (TEXT, never null), `credential_scope` (TEXT,
   e.g. `dns:edit` or `adsense:read`), `account_id` (TEXT, opaque vendor
   account identifier), `created_at`, `updated_at`. Unique index on
   `(tenant_id, provider_type, provider_name)`.

2. **Encryption at rest**: `CredentialVaultService` derives a data-encryption
   key from `VAULT_ENCRYPTION_KEY` via `scryptSync` (random 16-byte salt
   stored alongside the ciphertext) and encrypts with AES-256-GCM (12-byte
   nonce, 16-byte auth tag). Ciphertext = `salt || nonce || tag ||
   ciphertext`, base64-encoded for storage. Decryption verifies the auth
   tag before returning plaintext — tampered ciphertext raises
   `VaultDecryptionError`.

3. **CredentialProvider abstraction** (`src/providers/credentials/`):
   `getCredential(tenantId, providerType, providerName)` returns the
   decrypted plaintext for a single provider call; `setCredential(...)`
   encrypts and stores. The community edition without `VAULT_ENCRYPTION_KEY`
   gets a `NoOpCredentialVault` that refuses writes and returns undefined
   for reads — providers degrade to their existing env-based configuration.

4. **API + CLI**: `PUT /api/v1/tenant/credentials`, `GET` (metadata only,
   never plaintext), `DELETE`, plus `dominus credentials set|get|clear`
   commands. The dashboard shows provider name + scope + last updated, not
   the secret.

5. **Rotation**: re-encrypt on next write; old ciphertext is replaced. No
   re-encryption of existing rows on key rotation — the operator must
   re-set each credential after rotating `VAULT_ENCRYPTION_KEY`.

## Consequences

**Positive:** tenants can connect their own registrar/parking/AdSense
accounts without the platform ever seeing plaintext in logs or backups;
the same vault serves every future provider; fail-closed when unconfigured.

**Negative:** key loss is permanent (no password recovery by design — the
operator must re-set credentials); decryption adds latency to every
provider call (sub-millisecond, acceptable); the operator must safeguard
`VAULT_ENCRYPTION_KEY` outside the database (env file with 0600, secret
manager, etc.).

**Risk Assessment:** low. Plaintext never touches storage; the only
plaintext lifetime is in-memory during a single provider call. The
encryption construction (scrypt + AES-GCM) is standard and uses Node's
built-in `crypto`, no new dependencies.

## Compliance Check

- [x] ADR-0004 provider abstraction: credentials resolved through an
  interface, never hardcoded into business logic.
- [x] ADR-0082 honesty: the vault stores credentials; adapters are enabled
  only when verified against the real vendor API.
- [x] ADR-0038 tenant isolation: repository queries filter on
  `resolveTenantId()`.
- [x] Security: no credentials in logs, errors, or API responses; at-rest
  encryption with authenticated ciphertext.
- [x] English identifiers and documentation throughout.
