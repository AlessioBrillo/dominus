export const OPENAPI_SPEC: Record<string, unknown> = {
  openapi: '3.1.0',
  info: {
    title: 'DOMINUS API',
    version: '0.4.0-dev',
    description: `REST API for the DOMINUS domain investment decision-support engine.

Authentication via \`Authorization: Bearer <api-key>\` header.
The \`/public\` and \`/api/health\` endpoints are unauthenticated.`,
    contact: { url: 'https://github.com/AlessioBrillo/dominus' },
    license: { name: 'AGPL-3.0-only', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
  },
  servers: [
    { url: '/api/v1', description: 'API v1 (protected)' },
    { url: '/public', description: 'Public endpoints' },
  ],
  paths: {
    '/api/v1/candidates': {
      get: {
        tags: ['Candidates'],
        summary: 'List candidates for a pipeline run',
        parameters: [
          {
            name: 'runId',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'List of domain candidates',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    candidates: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Candidate' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Candidates'],
        summary: 'Run pipeline for candidates',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  keywords: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Keyword-based names',
                  },
                  brandableNames: { type: 'array', items: { type: 'string' } },
                  closeoutDomains: { type: 'array', items: { type: 'string' } },
                  closeoutEntries: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        domain: { type: 'string' },
                        domainAge: { type: 'number' },
                        backlinks: { type: 'number' },
                        waybackSnapshots: { type: 'number' },
                      },
                      required: ['domain'],
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Pipeline run completed with results' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/api/v1/runs': {
      get: {
        tags: ['Runs'],
        summary: 'List pipeline runs',
        parameters: [
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000 } },
        ],
        responses: {
          '200': { description: 'List of pipeline runs' },
        },
      },
      post: {
        tags: ['Runs'],
        summary: 'Submit a pipeline run (sync or async)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  keywords: { type: 'array', items: { type: 'string' } },
                  brandableNames: { type: 'array', items: { type: 'string' } },
                  closeoutDomains: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Synchronous run completed' },
          '202': { description: 'Run queued (async mode)' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/api/v1/runs/{runId}': {
      get: {
        tags: ['Runs'],
        summary: 'Get pipeline run details',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Run details' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/runs/{runId}/candidates': {
      get: {
        tags: ['Runs'],
        summary: 'Get candidates for a run',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Candidates for the run' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/runs/{runId}/stream': {
      get: {
        tags: ['Runs'],
        summary: 'SSE stream for live pipeline progress',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Server-Sent Events stream' },
          '501': { description: 'SSE not available' },
        },
      },
    },
    '/api/v1/runs/{runId}/job': {
      get: {
        tags: ['Runs'],
        summary: 'Check job queue status for a run',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Job status' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/runs/prune': {
      post: {
        tags: ['Runs'],
        summary: 'Delete expired runs',
        responses: {
          '200': {
            description: 'Prune result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    deleted: { type: 'integer' },
                    remaining: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/portfolio': {
      get: {
        tags: ['Portfolio'],
        summary: 'List portfolio entries',
        responses: {
          '200': {
            description: 'Portfolio entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    portfolio: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/PortfolioEntry' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Portfolio'],
        summary: 'Add domain to portfolio',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PortfolioInput' },
            },
          },
        },
        responses: {
          '201': { description: 'Portfolio entry created' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/api/v1/portfolio/{domain}': {
      delete: {
        tags: ['Portfolio'],
        summary: 'Remove domain from portfolio',
        parameters: [{ name: 'domain', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Domain removed' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/score/{domain}': {
      get: {
        tags: ['Scoring'],
        summary: 'Score a single domain',
        parameters: [
          { name: 'domain', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'closeout', in: 'query', schema: { type: 'boolean' } },
          { name: 'age', in: 'query', schema: { type: 'number' } },
          { name: 'backlinks', in: 'query', schema: { type: 'number' } },
          { name: 'wayback', in: 'query', schema: { type: 'number' } },
        ],
        responses: {
          '200': { description: 'Score result with optional trademark gate verdict' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/api/v1/providers': {
      get: {
        tags: ['System'],
        summary: 'List provider statuses',
        responses: {
          '200': { description: 'Provider health statuses' },
        },
      },
    },
    '/api/v1/outcomes': {
      get: {
        tags: ['Portfolio'],
        summary: 'List outcomes',
        responses: {
          '200': { description: 'Outcomes list' },
        },
      },
      post: {
        tags: ['Portfolio'],
        summary: 'Record an outcome',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  portfolioId: { type: 'integer' },
                  type: { type: 'string', enum: ['sold', 'dropped', 'expired', 'renewed'] },
                  occurredAt: { type: 'string' },
                  salePriceEur: { type: 'number' },
                  listingPriceEur: { type: 'number' },
                  venue: { type: 'string' },
                },
                required: ['portfolioId', 'type', 'occurredAt'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Outcome recorded' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/api/v1/auth': {
      get: {
        tags: ['System'],
        summary: 'Validate API key',
        responses: {
          '200': { description: 'Auth status' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/api/v1/alerts': {
      get: {
        tags: ['Portfolio'],
        summary: 'List renewal alerts',
        responses: {
          '200': { description: 'Renewal alerts' },
        },
      },
      post: {
        tags: ['Portfolio'],
        summary: 'Trigger renewal check',
        responses: {
          '200': { description: 'Check completed' },
        },
      },
    },
    '/api/v1/scheduler': {
      get: {
        tags: ['System'],
        summary: 'List scheduled jobs',
        responses: {
          '200': { description: 'Scheduler status' },
          '501': { description: 'Scheduler not enabled' },
        },
      },
    },
    '/api/v1/watchlist': {
      get: {
        tags: ['Watchlist'],
        summary: 'List watched domains',
        responses: {
          '200': { description: 'Watchlist entries' },
        },
      },
      post: {
        tags: ['Watchlist'],
        summary: 'Add domain to watchlist',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  domain: { type: 'string' },
                  tld: { type: 'string' },
                  maxPrice: { type: 'number' },
                  notes: { type: 'string' },
                },
                required: ['domain', 'tld'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Added to watchlist' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
      delete: {
        tags: ['Watchlist'],
        summary: 'Remove from watchlist',
        parameters: [{ name: 'id', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Removed from watchlist' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/purchase': {
      post: {
        tags: ['Purchases'],
        summary: 'Purchase a domain',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  domain: { type: 'string' },
                  price: { type: 'number' },
                  registrar: { type: 'string' },
                },
                required: ['domain', 'price'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Purchase completed' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/api/v1/bids': {
      get: {
        tags: ['Purchases'],
        summary: 'List bids',
        responses: {
          '200': { description: 'Bids list' },
        },
      },
    },
    '/api/v1/report': {
      get: {
        tags: ['Portfolio'],
        summary: 'Portfolio report',
        responses: {
          '200': { description: 'Portfolio report' },
        },
      },
    },
    '/api/v1/analytics': {
      get: {
        tags: ['Analytics'],
        summary: 'Prediction accuracy analytics',
        responses: {
          '200': { description: 'Analytics data' },
        },
      },
    },
    '/api/v1/listings': {
      get: {
        tags: ['Sales'],
        summary: 'List active listings',
        responses: {
          '200': { description: 'Listings' },
        },
      },
      post: {
        tags: ['Sales'],
        summary: 'Create a listing',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  domain: { type: 'string' },
                  price: { type: 'number' },
                  marketplace: { type: 'string' },
                },
                required: ['domain', 'price'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Listing created' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/api/v1/onboarding': {
      post: {
        tags: ['System'],
        summary: 'Run sample pipeline for onboarding',
        responses: {
          '200': { description: 'Sample run result' },
        },
      },
    },
    '/api/v1/backtest': {
      get: {
        tags: ['Scoring'],
        summary: 'Backtest results',
        responses: {
          '200': { description: 'Backtest data' },
        },
      },
      post: {
        tags: ['Scoring'],
        summary: 'Suggest weight adjustments',
        responses: {
          '200': { description: 'Weight suggestions' },
        },
      },
    },
    '/api/v1/metrics': {
      get: {
        tags: ['System'],
        summary: 'Pipeline metrics',
        responses: {
          '200': { description: 'Metrics snapshot' },
        },
      },
    },
    '/api/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        responses: {
          '200': {
            description: 'Service health',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    uptime: { type: 'number' },
                    version: { type: 'string' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/health/providers': {
      get: {
        tags: ['System'],
        summary: 'Provider health check',
        responses: {
          '200': {
            description: 'Provider statuses',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok', 'degraded'] },
                    providers: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/public/domain/{domain}': {
      get: {
        tags: ['Public'],
        summary: 'Score a domain publicly (no auth required)',
        parameters: [{ name: 'domain', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Score result (JSON or HTML)' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/public/scores': {
      post: {
        tags: ['Public'],
        summary: 'Create a shareable score snapshot',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  domain: { type: 'string' },
                },
                required: ['domain'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Score snapshot created with slug URL' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/public/s/{slug}': {
      get: {
        tags: ['Public'],
        summary: 'Get shareable score by slug',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Score data (JSON or HTML)' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/public/compare/{slug1}/{slug2}': {
      get: {
        tags: ['Public'],
        summary: 'Compare two scored domains',
        parameters: [
          { name: 'slug1', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'slug2', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Comparison data (JSON or HTML)' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/public/sitemap.xml': {
      get: {
        tags: ['Public'],
        summary: 'Sitemap for shareable scores',
        responses: {
          '200': {
            description: 'XML sitemap',
            content: { 'application/xml': { schema: { type: 'string' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Candidate: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          domain: { type: 'string' },
          tld: { type: 'string' },
          source: { type: 'string' },
          status: { type: 'string' },
          pipelineRunId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      PortfolioEntry: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          domain: { type: 'string' },
          tld: { type: 'string' },
          acquiredAt: { type: 'string', format: 'date-time' },
          renewalDate: { type: 'string', format: 'date-time' },
          acquisitionCost: { type: 'number' },
          renewalCost: { type: 'number' },
          registrar: { type: 'string' },
          dropVerdict: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      PortfolioInput: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          tld: { type: 'string' },
          acquiredAt: { type: 'string' },
          renewalDate: { type: 'string' },
          acquisitionCost: { type: 'number' },
          renewalCost: { type: 'number' },
          registrar: { type: 'string' },
          notes: { type: 'string' },
        },
        required: [
          'domain',
          'tld',
          'acquiredAt',
          'renewalDate',
          'acquisitionCost',
          'renewalCost',
          'registrar',
        ],
      },
      ScoreResult: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          expectedValue: { type: 'number' },
          confidence: { type: 'number' },
          suggestedBuyMax: { type: 'number' },
          suggestedListPrice: { type: 'number' },
          weightedScore: { type: 'number' },
          recommended: { type: 'boolean' },
          scoredAt: { type: 'string', format: 'date-time' },
          breakdown: { type: 'object' },
          signalStatus: { type: 'array', items: { type: 'object' } },
        },
      },
      ApiError: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['code', 'message'],
          },
        },
        required: ['error'],
      },
    },
    responses: {
      ValidationError: {
        description: 'Validation error',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ApiError' },
          },
        },
      },
      NotFound: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ApiError' },
          },
        },
      },
    },
    securitySchemes: {
      ApiKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'API key authentication. Send a valid API key in the Authorization header.',
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
};
