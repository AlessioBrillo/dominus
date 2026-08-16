// SPDX-License-Identifier: AGPL-3.0-only
export class DominusError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  override readonly cause: Error | undefined;

  constructor(message: string, code: string, context: Record<string, unknown> = {}, cause?: Error) {
    super(message);
    this.name = 'DominusError';
    this.code = code;
    this.context = context;
    this.cause = cause;
  }
}

export class ProviderError extends DominusError {
  readonly provider: string;
  constructor(
    message: string,
    provider: string,
    code = 'PROVIDER_ERROR',
    context: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(message, code, { provider, ...context }, cause);
    this.name = 'ProviderError';
    this.provider = provider;
  }
}

export class ProviderNotImplementedError extends ProviderError {
  constructor(provider: string, method: string) {
    super(`${method} not implemented in ${provider}`, provider, 'PROVIDER_NOT_IMPLEMENTED');
    this.name = 'ProviderNotImplementedError';
  }
}

export class ScoringError extends DominusError {
  constructor(message: string) {
    super(message, 'SCORING_ERROR');
    this.name = 'ScoringError';
  }
}

export class PortfolioError extends DominusError {
  constructor(message: string, code = 'PORTFOLIO_ERROR') {
    super(message, code);
    this.name = 'PortfolioError';
  }
}

export class DuplicateDomainError extends PortfolioError {
  readonly domain: string;
  constructor(domain: string) {
    super(`Domain already in portfolio: ${domain}`, 'DUPLICATE_DOMAIN');
    this.name = 'DuplicateDomainError';
    this.domain = domain;
  }
}

export class DomainNotFoundError extends PortfolioError {
  readonly domain: string;
  constructor(domain: string) {
    super(`Domain not found in portfolio: ${domain}`, 'DOMAIN_NOT_FOUND');
    this.name = 'DomainNotFoundError';
    this.domain = domain;
  }
}

export class PipelineError extends DominusError {
  readonly stage: string;
  constructor(message: string, stage: string) {
    super(message, 'PIPELINE_ERROR');
    this.name = 'PipelineError';
    this.stage = stage;
  }
}

export class TrademarkGateError extends DominusError {
  constructor(message: string) {
    super(message, 'TRADEMARK_GATE_ERROR');
    this.name = 'TrademarkGateError';
  }
}

export class ConfigError extends DominusError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class DatabaseError extends DominusError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR');
    this.name = 'DatabaseError';
  }
}

export class UsageLimitExceededError extends DominusError {
  readonly feature: string;
  readonly current: number;
  readonly requested: number;
  readonly limitValue: number | null;
  constructor(feature: string, current: number, requested: number, limitValue: number | null) {
    super(
      `Usage limit exceeded for ${feature}: ${current} + ${requested} > ${limitValue}`,
      'USAGE_LIMIT_EXCEEDED',
      { feature, current, requested, limitValue },
    );
    this.name = 'UsageLimitExceededError';
    this.feature = feature;
    this.current = current;
    this.requested = requested;
    this.limitValue = limitValue;
  }
}

/**
 * Raised when a tenant tries to mint an API key beyond its plan's seat
 * allowance (free = 1, pro = 3, team = 10, enterprise = unlimited).
 * Mapped to HTTP 403 SEAT_LIMIT_EXCEEDED by the error handler.
 */
export class SeatLimitExceededError extends DominusError {
  readonly plan: string;
  readonly seats: number;
  constructor(plan: string, seats: number) {
    super(
      `Seat limit reached for the ${plan} plan (${seats} active key${seats === 1 ? '' : 's'})`,
      'SEAT_LIMIT_EXCEEDED',
      {
        plan,
        seats,
      },
    );
    this.name = 'SeatLimitExceededError';
    this.plan = plan;
    this.seats = seats;
  }
}

/**
 * Raised when a suspended tenant attempts a metered operation (ADR-0057).
 * Mapped to HTTP 403 TENANT_SUSPENDED by the error handler; the API-level
 * middleware rejects suspended tenants before any work starts, this error
 * covers the pipeline/CLI chokepoints that bypass the HTTP layer.
 */
export class TenantSuspendedError extends DominusError {
  constructor(tenantId: string) {
    super(`Tenant '${tenantId}' is suspended. Contact the platform operator.`, 'TENANT_SUSPENDED', {
      tenantId,
    });
    this.name = 'TenantSuspendedError';
  }
}
