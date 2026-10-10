// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Compact operation table for the OpenAPI document.
 *
 * Detailed schemas for the core flows are written by hand in openapi-spec.ts.
 * Everything else the server mounts is declared here once, as one line per
 * operation, so the contract cannot silently fall behind the routers. The
 * coverage test (src/api/__tests__/openapi-coverage.test.ts) reads the real
 * routers and fails when an operation is missing here or in the hand-written
 * part, or documented but not implemented.
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface OperationSpec {
  tag: string;
  summary: string;
  /** Request has a JSON body. */
  body?: boolean;
  /** Required caller role beyond authentication. */
  role?: 'admin' | 'operator';
  /** Query parameters. */
  query?: readonly string[];
  /** Success status (default 200). */
  success?: '200' | '201' | '204';
}

/** [method, path (without /api/v1), spec] */
type Row = readonly [Method, string, OperationSpec];

const ROWS: readonly Row[] = [
  // Identity
  ['get', '/me', { tag: 'Identity', summary: 'Effective identity of the caller (role, tenant)' }],

  // Team
  ['get', '/team', { tag: 'Team', summary: 'Seat usage, members and pending invitations' }],
  [
    'post',
    '/team/invite',
    {
      tag: 'Team',
      summary:
        'Invite by email (returns a one-time link; emails it when SMTP is configured) or, legacy, by user id',
      body: true,
      role: 'admin',
      success: '201',
    },
  ],
  [
    'delete',
    '/team/invitations/{id}',
    { tag: 'Team', summary: 'Revoke a pending invitation', role: 'admin', success: '204' },
  ],
  [
    'post',
    '/team/accept',
    { tag: 'Team', summary: 'Activate the caller own pending seat (legacy)' },
  ],
  [
    'patch',
    '/team/{userId}/role',
    { tag: 'Team', summary: 'Change a member role', body: true, role: 'admin' },
  ],
  ['delete', '/team/{userId}', { tag: 'Team', summary: 'Remove a member', role: 'admin' }],

  // API keys
  [
    'get',
    '/keys',
    { tag: 'API keys', summary: 'List API keys of the tenant (prefix only)', role: 'admin' },
  ],
  [
    'post',
    '/keys',
    {
      tag: 'API keys',
      summary: 'Create an API key; the secret is returned once',
      body: true,
      role: 'admin',
      success: '201',
    },
  ],
  [
    'delete',
    '/keys/{id}',
    { tag: 'API keys', summary: 'Revoke an API key', role: 'admin', success: '204' },
  ],

  // Billing and usage
  ['get', '/billing', { tag: 'Billing', summary: 'Subscription, plan and billing status' }],
  [
    'post',
    '/billing/checkout',
    { tag: 'Billing', summary: 'Start a Stripe checkout session', body: true },
  ],
  ['post', '/billing/portal', { tag: 'Billing', summary: 'Open the Stripe customer portal' }],
  ['get', '/usage', { tag: 'Usage', summary: 'Metered usage for the current period' }],
  ['get', '/usage/history', { tag: 'Usage', summary: 'Usage history by day' }],
  ['get', '/usage/limits', { tag: 'Usage', summary: 'Plan limits' }],
  ['post', '/usage/record', { tag: 'Usage', summary: 'Record a usage unit', body: true }],

  // Operator panel (cross-tenant)
  [
    'get',
    '/admin/overview',
    { tag: 'Operator', summary: 'Platform-wide totals', role: 'operator' },
  ],
  [
    'get',
    '/admin/tenants',
    { tag: 'Operator', summary: 'Tenants with plan and usage', role: 'operator' },
  ],
  [
    'get',
    '/admin/tenants/{tenantId}',
    { tag: 'Operator', summary: 'Tenant detail with operator flags', role: 'operator' },
  ],
  [
    'get',
    '/admin/tenants/{tenantId}/custom-prices',
    { tag: 'Operator', summary: 'Custom Stripe prices of a tenant', role: 'operator' },
  ],
  [
    'post',
    '/admin/tenants/{tenantId}/custom-prices',
    {
      tag: 'Operator',
      summary: 'Register a custom Stripe price for a tenant',
      body: true,
      role: 'operator',
      success: '201',
    },
  ],
  [
    'get',
    '/admin/custom-prices/{priceId}',
    { tag: 'Operator', summary: 'Look up a custom price', role: 'operator' },
  ],
  [
    'delete',
    '/admin/custom-prices/{priceId}',
    { tag: 'Operator', summary: 'Delete a custom price', role: 'operator', success: '204' },
  ],

  // Alerts
  [
    'post',
    '/alerts/acknowledge-all',
    { tag: 'Portfolio', summary: 'Acknowledge all (or one domain) alerts', body: true },
  ],
  ['post', '/alerts/run', { tag: 'Portfolio', summary: 'Run the renewal check now' }],
  ['post', '/alerts/{id}/acknowledge', { tag: 'Portfolio', summary: 'Acknowledge one alert' }],

  // Analytics and reports
  ['get', '/analytics/accuracy', { tag: 'Analytics', summary: 'Prediction accuracy report' }],
  ['get', '/analytics/pnl', { tag: 'Analytics', summary: 'Portfolio profit and loss' }],
  ['post', '/analytics/refresh', { tag: 'Analytics', summary: 'Recompute accuracy scores' }],
  ['get', '/report', { tag: 'Reports', summary: 'Portfolio report' }],
  ['get', '/report/risk', { tag: 'Reports', summary: 'Renewal and concentration risk' }],
  ['get', '/report/roi', { tag: 'Reports', summary: 'Return on investment by domain' }],
  ['get', '/report/tld', { tag: 'Reports', summary: 'Breakdown by TLD' }],

  // Scoring feedback
  [
    'post',
    '/backtest/auto-tune',
    { tag: 'Scoring', summary: 'Tune scoring weights from outcomes', body: true },
  ],
  ['post', '/backtest/report', { tag: 'Scoring', summary: 'Backtest report', body: true }],
  [
    'post',
    '/backtest/snapshot',
    { tag: 'Scoring', summary: 'Snapshot the current weights', body: true },
  ],
  [
    'post',
    '/backtest/suggest-weights',
    { tag: 'Scoring', summary: 'Suggest weight adjustments', body: true },
  ],

  // Bids and purchases
  ['get', '/bids/pending', { tag: 'Purchases', summary: 'Pending bids' }],
  ['get', '/bids/{domain}', { tag: 'Purchases', summary: 'Bids for a domain' }],
  [
    'post',
    '/bids/place',
    { tag: 'Purchases', summary: 'Record a placed bid', body: true, success: '201' },
  ],
  ['post', '/bids/resolve', { tag: 'Purchases', summary: 'Resolve a bid (won/lost)', body: true }],
  [
    'get',
    '/purchase/preflight',
    {
      tag: 'Purchases',
      summary: 'Pre-purchase checks (availability, trademark, budget)',
      query: ['domain'],
    },
  ],
  [
    'get',
    '/purchase/price',
    { tag: 'Purchases', summary: 'Registrar price quote', query: ['domain'] },
  ],
  [
    'post',
    '/purchase/execute',
    { tag: 'Purchases', summary: 'Buy a domain through the registrar', body: true },
  ],

  // Pipeline
  [
    'post',
    '/candidates/run',
    { tag: 'Candidates', summary: 'Run the pipeline for candidates', body: true },
  ],
  [
    'delete',
    '/runs/{runId}',
    { tag: 'Runs', summary: 'Delete a run of the tenant', role: 'admin', success: '204' },
  ],
  ['get', '/funnel/{runId}', { tag: 'Runs', summary: 'Acquisition funnel of a run' }],
  ['post', '/funnel/{runId}/generate', { tag: 'Runs', summary: 'Generate the funnel for a run' }],

  // Listings and offers
  ['get', '/listings/{id}', { tag: 'Sales', summary: 'Listing detail' }],
  ['patch', '/listings/{id}', { tag: 'Sales', summary: 'Update a listing', body: true }],
  ['delete', '/listings/{id}', { tag: 'Sales', summary: 'Delete a listing', success: '204' }],
  ['post', '/listings/sync', { tag: 'Sales', summary: 'Sync listing state with the provider' }],
  ['post', '/listings/{id}/publish', { tag: 'Sales', summary: 'Mark a listing as listed' }],
  ['get', '/listings/{id}/offers', { tag: 'Sales', summary: 'Offers on a listing' }],
  [
    'post',
    '/listings/{id}/offers',
    { tag: 'Sales', summary: 'Record an offer', body: true, success: '201' },
  ],
  [
    'post',
    '/listings/{listingId}/offers/{offerId}/accept',
    { tag: 'Sales', summary: 'Accept an offer' },
  ],
  [
    'post',
    '/listings/{listingId}/offers/{offerId}/decline',
    { tag: 'Sales', summary: 'Decline an offer' },
  ],

  // Onboarding
  ['get', '/onboarding/state', { tag: 'Onboarding', summary: 'Wizard state' }],
  ['patch', '/onboarding/state', { tag: 'Onboarding', summary: 'Update wizard state', body: true }],
  ['post', '/onboarding/sample-run', { tag: 'Onboarding', summary: 'Run the sample pipeline' }],
  [
    'post',
    '/onboarding/portfolio/import',
    { tag: 'Onboarding', summary: 'Import and score a domain list', body: true },
  ],

  // Outcomes
  [
    'get',
    '/outcomes/stats/{domain}',
    { tag: 'Portfolio', summary: 'Outcome statistics for a domain' },
  ],

  // Portfolio
  ['post', '/portfolio/rescore', { tag: 'Portfolio', summary: 'Rescore the portfolio' }],
  [
    'post',
    '/portfolio/verdicts',
    { tag: 'Portfolio', summary: 'Compute keep/drop/reprice verdicts', body: true },
  ],
  [
    'patch',
    '/portfolio/{domain}',
    { tag: 'Portfolio', summary: 'Update a portfolio entry', body: true },
  ],
  [
    'delete',
    '/portfolio/{domain}',
    { tag: 'Portfolio', summary: 'Remove a portfolio entry', success: '204' },
  ],
  [
    'patch',
    '/portfolio/{domain}/verdict',
    { tag: 'Portfolio', summary: 'Set the verdict of an entry', body: true },
  ],
  ['get', '/portfolio/{domain}/outcomes', { tag: 'Portfolio', summary: 'Outcomes for a domain' }],
  [
    'post',
    '/portfolio/{domain}/outcomes',
    { tag: 'Portfolio', summary: 'Record an outcome for a domain', body: true, success: '201' },
  ],
  [
    'get',
    '/portfolio/{domain}/outcomes/stats',
    { tag: 'Portfolio', summary: 'Outcome statistics for a domain' },
  ],

  // System
  ['get', '/providers/status', { tag: 'System', summary: 'Provider health and configuration' }],
  ['post', '/scheduler/run/{job}', { tag: 'System', summary: 'Run a scheduled job now' }],
  ['get', '/system/worker', { tag: 'System', summary: 'Job worker status' }],

  // Watchlist
  ['get', '/watchlist/{domain}', { tag: 'Watchlist', summary: 'Watchlist entry' }],
  ['delete', '/watchlist/{domain}', { tag: 'Watchlist', summary: 'Remove from the watchlist' }],
  ['post', '/watchlist/poll', { tag: 'Watchlist', summary: 'Poll watched domains now' }],
];

function operationFor(path: string, spec: OperationSpec): Record<string, unknown> {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  const queryParams = (spec.query ?? []).map((name) => ({
    name,
    in: 'query',
    required: true,
    schema: { type: 'string' },
  }));
  const success = spec.success ?? '200';
  const roleNote =
    spec.role === 'operator'
      ? ' Requires the platform operator role (OPERATOR_SUBJECTS).'
      : spec.role === 'admin'
        ? ' Requires the tenant admin role.'
        : '';
  return {
    tags: [spec.tag],
    summary: spec.summary,
    ...(roleNote ? { description: roleNote.trim() } : {}),
    ...(pathParams.length + queryParams.length > 0
      ? { parameters: [...pathParams, ...queryParams] }
      : {}),
    ...(spec.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        }
      : {}),
    responses: {
      [success]: { description: success === '204' ? 'No content' : 'Success' },
      ...(spec.body ? { '400': { $ref: '#/components/responses/ValidationError' } } : {}),
      ...(path.includes('{') ? { '404': { $ref: '#/components/responses/NotFound' } } : {}),
      ...(spec.role ? { '403': { description: 'Insufficient role' } } : {}),
    },
  };
}

/**
 * Adds every table operation that the hand-written paths do not already
 * define. Hand-written entries win, so a detailed schema is never replaced.
 */
export function withTableOperations(
  handWritten: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = { ...handWritten };
  for (const [method, path, spec] of ROWS) {
    const key = `/api/v1${path}`;
    const item = { ...(paths[key] ?? {}) };
    if (!item[method]) item[method] = operationFor(path, spec);
    paths[key] = item;
  }
  return paths;
}
