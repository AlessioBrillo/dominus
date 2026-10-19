# Data-subject rights: export and erasure

GDPR art. 15 (access and portability) and art. 17 (erasure) are exposed as
two operations that walk the same registry of tenant-scoped tables, so what
the export returns and what the erasure removes can never disagree.

| | |
|---|---|
| API | `GET /api/v1/tenant/export`, `DELETE /api/v1/tenant` |
| CLI | `dominus tenant export --tenant <id>`, `dominus tenant delete --tenant <id> --confirm <id>` |
| Who may call it | a tenant admin (the service holds the team's data, not only one person's) |
| Which tenant | always the tenant the caller was authenticated for; the request body cannot choose another one |

## Export

```bash
curl -H "Authorization: Bearer $DOMINUS_KEY" \
  https://your-deployment/api/v1/tenant/export > export.json
```

```bash
dominus tenant export --tenant acme --out export.json
```

The response is a snapshot of every tenant-scoped table:

```json
{
  "tenantId": "acme",
  "generatedAt": "2026-10-20T09:00:00.000Z",
  "formatVersion": 1,
  "tables": [{ "table": "candidates", "rows": [], "truncated": false }],
  "totalRows": 0,
  "retainedTables": []
}
```

- `formatVersion` exists so an export taken today can still be interpreted
  after the schema has moved on.
- `truncated` is `true` when a table hit the per-table row cap (100,000
  rows). The flag is never silent: a truncated export is an incomplete
  export, and the data subject is told.

## Erasure

```bash
curl -X DELETE -H "Authorization: Bearer $DOMINUS_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"confirm":"acme"}' \
  https://your-deployment/api/v1/tenant
```

```bash
dominus tenant delete --tenant acme --confirm acme
```

The confirmation must be the tenant id, typed on purpose: an erasure that
cannot be tied to a deliberate act is an accident waiting to happen. The
whole operation runs in one transaction — a partial erasure is worse than a
refused one, because it looks like a completed one.

The report says what was erased, table by table.

### What the erasure does not reach

Two limits are declared in the privacy notice and in the data processing
agreement, and they are not bugs:

- **Backups.** The rolling backup window (about thirty days by default) is
  overwritten by the rotation. A copy restored from a backup is re-erased
  after the restore.
- **Records kept for law.** The invoices live in the payment provider and
  follow that provider's retention; the accounting obligation does not
  disappear because the tenant did.

Everything else — candidates, scores, portfolio entries, runs, listings,
bids, watchlist, the automation journal and audit trail, the provider
credentials in the vault, the API keys, the team, the usage records and the
local subscription record — is erased.

## The registry

`src/db/tenant-data-registry.ts` lists the tenant-scoped tables in deletion
order, children before parents. A test
(`src/db/__tests__/tenant-data-registry.test.ts`) checks the registry against
the migrated schema in both directions and checks the order against the
foreign keys, so a new table with a `tenant_id` column cannot be added
without being listed: the test fails until the registry knows about it.

## On PostgreSQL

The service is not the only thing that protects the isolation. The
`dominus_app` role is not the database owner and row-level security is
`FORCE`d, so the policies apply on top of the explicit `WHERE tenant_id = ?`
that every statement carries. A bug in this service still cannot read
another tenant's rows.
