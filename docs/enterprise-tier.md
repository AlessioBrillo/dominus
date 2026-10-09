# Enterprise tier

What ships in v1.1.0 and what is a contract engagement.

| Capability                 | State       | Notes                                                                                                                                                                                                                                                    |
| -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single sign-on             | Shipped     | OIDC Authorization Code + PKCE against Auth0 ([ADR-0062](adr/0062-enterprise-sso.md)); sessions are resolved to a tenant from team seats ([ADR-0081](adr/0081-operator-role-and-team-invitations.md))                                                    |
| Unlimited seats            | Shipped     | The Enterprise plan has no seat cap; teams invite by email                                                                                                                                                                                               |
| Custom pricing             | Shipped     | Per-tenant **Stripe prices** (not per-domain pricing): an operator registers a price for a tenant; at checkout completion the tenant and the amount paid are checked before the plan is granted. Operator API: `/api/v1/admin/tenants/:id/custom-prices` |
| Operator panel             | Shipped     | Overview, tenant drill-down, suspend/unsuspend and plan override, restricted to the platform operator role                                                                                                                                               |
| Service level agreement    | Draft       | [operations/sla.md](operations/sla.md) — figures need approval before use in a contract                                                                                                                                                                  |
| Dedicated infrastructure   | On contract | Terraform modules for a dedicated app node and PITR database node live in `deploy/terraform/`; provisioning is an engagement, not a self-service plan                                                                                                    |
| Third-party security audit | Not done    | A first-party review of the multi-tenant surface was done for 1.1.0                                                                                                                                                                                      |

Commercial terms and contact: [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md).
