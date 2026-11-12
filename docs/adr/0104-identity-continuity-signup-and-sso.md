# ADR-0104: Identity continuity between the self-serve signup and single sign-on

## Metadata

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **Status**     | Accepted                                                              |
| **Date**       | 2026-11-11                                                            |
| **Authors**    | Alessio Brillo                                                        |
| **Deciders**   | Alessio Brillo                                                        |
| **Supersedes** | -                                                                     |
| **Relates to** | ADR-0062, ADR-0081, ADR-0032, ADR-0103                                 |
| **Project**    | DOMINUS                                                               |

## Context

DOMINUS has two ways to become a user, and they produced two different
identities for the same person.

- **Self-serve signup** (`POST /api/v1/auth/register`) creates a tenant, an
  owner seat and an API key. There is no identity provider in that flow,
  so the owner seat was stored with the **email address** as its user
  identifier.
- **Single sign-on** (`/api/v1/auth/oidc/*`) identifies a person by the
  identity-provider **subject** (`auth0|...`).

`IdentityTenantResolver` looked the tenant up by subject only. A person
who created a workspace with their email and later signed in with SSO was
not recognised: with auto-provisioning on they landed in a *second*,
empty tenant and lost sight of the workspace they had created; with
auto-provisioning off they were refused altogether. The data of the first
workspace became invisible and the support answer was "we cannot recover
it".

The second identity problem was the quota. The plan limits carried a
single number, `seats`, and it was checked against two different
populations:

- `TeamService` counted the **human** seats (the owner, the invited
  members);
- the key-management route counted the **API keys** and compared them
  with the same number.

The two checks were independent, so a tenant on a plan that sells three
seats could hold three humans *and* three machine credentials, and a
tenant whose three seats were taken by three humans could not create a
single key for its CI.

## Decision

1. **The tenant seat is the identity, and the email links it.** At
   sign-in the resolver looks for an active seat by subject; when there
   is none, it looks for an active seat whose identifier is the
   **verified** email returned by the identity provider. The seat is then
   re-linked to the subject (`team_seats.user_id` is moved), so the
   identity is stable from that moment on. The email is only accepted
   when the provider marked it verified (`email_verified === true`), which
   the Auth0 provider already enforces; an unverified email proves nothing
   and links nothing. The re-link is skipped when the subject already has
   a seat in that tenant: the subject's own seat wins.

2. **The seat quota and the machine-credential quota are separate.**
   `TEAM_PLAN_LIMITS` now carries `seats` (people) and `apiKeys` (machine
   credentials). The free plan seats one person and one key, Pro seats
   three people and five keys, Team seats ten people and twenty keys, and
   Enterprise is unlimited. Each quota is checked against its own
   population, in one place.

3. **The API key stays a machine credential, not a login.** The self-serve
   signup still returns a key, and the key remains the way a script
   authenticates. It is not, however, the only way a human can be
   identified: the seat and the verified email are.

## Consequences

### Positive

- A person who signs up with an email and later signs in with SSO lands in
  the workspace they created, with their data.
- The plan's promise ("three seats") means three people, and the machine
  credentials have their own, explicit quota.
- An unverified email cannot be used to claim a workspace.

### Negative / trade-offs

- The seat table carries a transient identifier (the email) for the
  workspaces created before the re-link happens. The re-link is
  irreversible by design: after it, the email is no longer the seat's
  identifier.
- A person whose workspace was created with one email and who signs in
  with SSO with a *different* verified email does not find the workspace.
  The support answer is still manual in that case.
- The identity model is still two-part (the community edition's static
  key versus the managed identity). The decision above repairs the
  continuity between the signup and SSO; it does not replace the API key
  with a full account system, which remains the open decision of the
  launch (an identity provider against an internal account).

### When this is revisited

When the account model is replaced (a real user table, email
verification, passwordless sign-in), the re-link becomes a merge of two
identity records instead of a move, and the email stops being an
identifier at all.
