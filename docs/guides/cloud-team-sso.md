# DOMINUS Cloud: teams, SSO and operators

This guide is for whoever runs a DOMINUS Cloud deployment (multi-tenant,
PostgreSQL). The Community edition has one tenant and static API keys; none of
this applies to it.

## Who can do what

| Role       | Scope        | Can                                                          |
| ---------- | ------------ | ------------------------------------------------------------ |
| `member`   | their tenant | use the app                                                  |
| `admin`    | their tenant | invite/remove people, change roles, manage API keys, billing |
| `operator` | all tenants  | operator panel: overview, suspend/unsuspend, plan override   |

`operator` is **not** something a tenant can obtain: it is granted only to the
subjects you list in `OPERATOR_SUBJECTS`. See
[ADR-0081](../adr/0081-operator-role-and-team-invitations.md).

## 1. Configure single sign-on

Set, on the API service:

```env
AUTH_PROVIDER=auth0
AUTH0_DOMAIN=your-tenant.eu.auth0.com
AUTH0_AUDIENCE=https://api.your-domain.example
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...            # also derives the session-signing key
AUTH0_CALLBACK_URL=https://app.your-domain.example/api/v1/auth/oidc/callback
PUBLIC_APP_URL=https://app.your-domain.example
CORS_ORIGIN=https://app.your-domain.example
METRICS_TOKEN=...                  # required in Cloud mode
```

In Auth0 register `AUTH0_CALLBACK_URL` as an allowed callback URL and its origin
(`https://app.your-domain.example`) as an allowed logout URL. The login screen then shows the
single-sign-on button. Sessions last `AUTH0_SESSION_TTL_HOURS` (default 8) and
there are no refresh tokens.

## 2. Make yourself an operator

Find your identity provider subject (the `sub` claim, e.g. `auth0|64f...`), or
the id of a database API key, and list it:

```env
OPERATOR_SUBJECTS=auth0|64f1c0ffee,key:12
```

Restart the API. Without this variable nobody can open `/admin`, and the Admin
link stays hidden for everyone.

## 3. How people get a tenant

- **First sign-in** with no team: with `OIDC_AUTO_PROVISION_TENANTS=true`
  DOMINUS creates a tenant on the free plan with the user as admin. This is
  **off by default**: without it a user who is not on a team (and has no IdP
  `org_id`) is rejected until an admin invites them. Turn it on for self-serve
  Cloud signup, leave it off for a private SSO deployment.
- **By invitation:** an admin opens **Team**, enters an email and a role. DOMINUS
  creates a single-use link (valid 7 days) and:
  - emails it, if `SMTP_URL` is set (`SMTP_FROM` sets the sender), or
  - shows it once so the admin can send it. This is the default with no SMTP.
- The invitee opens the link, signs in with SSO and accepts. Their session is
  re-issued for the team's tenant. The identity provider must report a
  **verified** email equal to the invited one, so a forwarded link is useless to
  anyone else. Revoke an invitation from **Team** at any time.

A user who belongs to several teams lands in the one they joined most recently;
there is no tenant switcher yet.

## 4. Seats

| Plan       | Seats     |
| ---------- | --------- |
| Free       | 1         |
| Pro        | 3         |
| Team       | 10        |
| Enterprise | unlimited |

A pending invitation holds a seat until it is accepted, revoked or expires.
When the plan is full, inviting returns "No seats left on your plan".

## 5. API keys for automation

People sign in with SSO; scripts and the CLI use API keys. Admins create them in
**Settings -> API keys**. The secret is shown once; only a hash is stored.
Revoke a key there at any time.

## 6. Suspending a tenant

As an operator open **Admin**, choose the tenant and **Suspend**. The tenant's
API access stops (the billing pages stay reachable so they can pay). Their own
admins cannot bypass a suspension.
