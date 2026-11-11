# ADR-0106: The launch posture of the SaaS surface

## Metadata

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **Status**     | Accepted                                                              |
| **Date**       | 2026-11-11                                                            |
| **Authors**    | Alessio Brillo                                                        |
| **Deciders**   | Alessio Brillo                                                        |
| **Supersedes** | -                                                                     |
| **Relates to** | ADR-0056, ADR-0038, ADR-0090, ADR-0043, ADR-0103                     |
| **Project**    | DOMINUS                                                               |

## Context

The scan that preceded the public launch of DOMINUS Cloud found five
defects in the surface a stranger and a paying tenant touch. They are
individually small and collectively a launch blocker, because the product
sells a promise ("your data, your decisions, your money") that these
defects contradict.

1. **The per-token rate limiter was keyed on the credential itself.** The
   bucket key was the raw `Authorization` header, so the API key lived in
   the limiter's keyspace (in memory today, in Redis as soon as the store
   is shared). The same key was the fallback for every browser session,
   because a session cookie carries no `Authorization` header: all the
   single sign-on users of the service shared one counter, and one busy
   tenant could exhaust the limit for everybody else.

2. **The redirect targets of the billing flow were compared as strings.**
   `successUrl`, `cancelUrl` and the portal `returnUrl` were accepted
   when they *started with* the configured origin, which accepts
   `https://dominus.app.attacker.tld`: the customer would be sent to a
   lookalike host with the session identifier in the query string.

3. **The data-subject export carried the credentials.** The export is
   produced with `SELECT *` over the tenant-scoped registry, so it
   carried the scrypt hash of every API key, the hash of every
   outstanding invitation token and the AES-256-GCM ciphertext of every
   stored provider credential. A data subject is entitled to their
   personal data, not to the service's secrets.

4. **The API key prefix was eight hex characters** (32 bits) and was the
   only index of the key. The column is unique, but the entropy is thin
   for a value that is used as a lookup key.

5. **The anonymous namespace drew from the shared trademark budget.** The
   public valuation pages call the trademark gate, and the budget that
   protects them (`ANON_TRADEMARK_BUDGET_ENABLED`) was off by default -
   in the Cloud too. The trademark providers are free public endpoints
   with per-IP limits: an anonymous traffic spike can exhaust the
   capacity a paying tenant's pipeline needs, and can get the operator's
   IP throttled by the upstream, which would silently break the gate for
   every customer.

## Decision

1. **The rate-limit bucket is keyed on the identity, never on the
   credential.** `buildIdentityRateLimitKey` returns the API key id, the
   digest of the session subject, the digest of the tenant, or the digest
   of the credential header as a last resort. No secret enters the
   keyspace, and every caller gets its own bucket.

2. **A redirect target is accepted when its parsed origin equals the
   configured origin.** `isAllowedAppUrl` compares origins, not prefixes.
   A deployment without a configured origin keeps the previous behaviour
   (it has declared no canonical origin to compare against).

3. **The export redacts the credential columns.** `api_keys.key_hash`,
   `team_invitations.token_hash` and
   `tenant_credentials.encrypted_credential` are replaced with a
   `[redacted]` marker. The key prefix is kept: it identifies the key for
   support and carries no usable entropy.

4. **The API key prefix is twelve hex characters** (48 bits), with the
   eight-character width kept as a fallback so the keys minted before the
   change keep working.

5. **The anonymous trademark budget is on by default in the Cloud.** The
   default follows the same rule as the rest of the configuration
   (`DATABASE_URL` set, or a non-`env` identity provider): the community
   edition behaves as before, and the managed edition protects the paid
   tenants' capacity from anonymous traffic.

## Consequences

### Positive

- No credential is ever used as a cache, a limiter or a queue key.
- Every caller is limited on its own bucket: one tenant cannot exhaust
  the limit of the others.
- The billing redirect cannot be pointed at a lookalike host.
- The data-subject export carries personal data, not secrets.
- An anonymous traffic spike cannot starve the trademark gate of the
  paying tenants.

### Negative / trade-offs

- The limiter key is a digest of the identity: an operator reading the
  limiter state can no longer tell which user a bucket belongs to
  without the digest.
- The export is no longer a faithful copy of the database: it is a
  redacted copy, and the redaction has to be documented in the privacy
  notice.
- The keys minted before the change keep an eight-character prefix, so
  the column carries two widths; the lookup tries both.

### When this is revisited

When the limiter moves to a shared store (the multi-replica topology),
the key derivation must stay the same: the identity, never the
credential.
