// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver as NodeResolver } from 'node:dns';
import {
  SecurityStatus,
  type ChainVerificationResult,
  type Resolver as DnssecResolver,
} from '@relaycorp/dnssec';

export type DnssecStatus = 'valid' | 'bogus' | 'insecure' | 'timeout' | 'error';

export interface DnssecValidationResult {
  status: DnssecStatus;
  chainValidated: boolean;
  error?: string;
  durationMs: number;
  validatedAt: string;
}

export interface ValidationOptions {
  timeoutMs?: number;
  resolver?: NodeResolver;
  /** Internal: injectable validate function for testing */
  _validateFn?: (
    domain: string,
    options: { resolver: DnssecResolver },
  ) => Promise<ChainVerificationResult>;
}

/**
 * Default validate function - throws in production because we need a proper
 * adapter from node:dns Resolver to @relaycorp/dnssec Resolver.
 * Tests should provide their own _validateFn.
 */
const defaultValidateFn = async (
  _domain: string,
  _options: { resolver: DnssecResolver },
): Promise<ChainVerificationResult> => {
  throw new Error(
    'Default validateFn not implemented for production - provide _validateFn in options or use a proper resolver adapter',
  );
};

/**
 * Per-query DNSSEC validation using @relaycorp/dnssec.
 * This provides cryptographic proof of DNSSEC validation for a specific domain,
 * unlike the resolver-level negative-control probe which only proves the resolver
 * is configured correctly.
 *
 * Returns:
 * - 'valid': Full DNSSEC chain validated (DS -> DNSKEY -> RRSIG all verify) -> SecurityStatus.SECURE
 * - 'bogus': DNSSEC validation failed (bad signature, missing RRSIG, etc.) -> SecurityStatus.BOGUS
 * - 'insecure': Zone is not signed (no DS record in parent) -> SecurityStatus.INSECURE
 * - 'timeout': Validation exceeded timeoutMs
 * - 'error': Network error, NXDOMAIN, or other resolution failure -> SecurityStatus.INDETERMINATE
 */
export async function validateDnssecPerQuery(
  domain: string,
  options: ValidationOptions = {},
): Promise<DnssecValidationResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const resolver = options.resolver ?? new NodeResolver();
  const validateFn = options._validateFn ?? defaultValidateFn;

  const startTime = Date.now();
  const validatedAt = new Date().toISOString();

  let result: ChainVerificationResult;

  try {
    const validationPromise = validateFn(domain, {
      resolver: resolver as unknown as DnssecResolver,
    });

    result = await Promise.race([
      validationPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Validation timeout')), timeoutMs);
      }),
    ]);
  } catch (err) {
    // Timeout or validation function threw
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);

    if (error.includes('timeout') || error.includes('Validation timeout')) {
      return {
        status: 'timeout',
        chainValidated: false,
        error: 'Validation timeout',
        durationMs,
        validatedAt,
      };
    }

    return {
      status: 'error',
      chainValidated: false,
      error,
      durationMs,
      validatedAt,
    };
  }

  const durationMs = Date.now() - startTime;

  switch (result.status) {
    case SecurityStatus.SECURE:
      return {
        status: 'valid',
        chainValidated: true,
        durationMs,
        validatedAt,
      };
    case SecurityStatus.BOGUS:
      return {
        status: 'bogus',
        chainValidated: false,
        error: result.reasonChain.join('; ') || 'DNSSEC validation failed (bogus signature)',
        durationMs,
        validatedAt,
      };
    case SecurityStatus.INSECURE:
      return {
        status: 'insecure',
        chainValidated: false,
        error: 'Zone is not signed (no DS record)',
        durationMs,
        validatedAt,
      };
    case SecurityStatus.INDETERMINATE:
      return {
        status: 'error',
        chainValidated: false,
        error: result.reasonChain.join('; ') || 'DNSSEC validation indeterminate',
        durationMs,
        validatedAt,
      };
  }
}

/**
 * Batch validation for multiple domains with concurrency control.
 */
export async function validateDnssecBatch(
  domains: string[],
  options: ValidationOptions & { concurrency?: number } = {},
): Promise<DnssecValidationResult[]> {
  const concurrency = options.concurrency ?? 10;
  const results: DnssecValidationResult[] = [];

  for (let i = 0; i < domains.length; i += concurrency) {
    const batch = domains.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((domain) => validateDnssecPerQuery(domain, options)),
    );
    results.push(...batchResults);
  }

  return results;
}
