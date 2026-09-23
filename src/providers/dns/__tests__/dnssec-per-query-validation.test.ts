// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateDnssecPerQuery } from '../dnssec-validation.js';
import type { ChainVerificationResult } from '@relaycorp/dnssec';

describe('DNSSEC Per-Query Validation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockValidateFn: any;

  beforeEach(() => {
    vi.resetModules();
    mockValidateFn = vi.fn();
  });

  describe('validateDnssecPerQuery', () => {
    it('should return valid for a properly signed zone with valid DNSSEC chain', async () => {
      mockValidateFn.mockResolvedValueOnce({ status: 'SECURE' } as ChainVerificationResult);

      const result = await validateDnssecPerQuery('sigok.verteiltesysteme.net', {
        timeoutMs: 5000,
        _validateFn: mockValidateFn,
      });

      expect(result.status).toBe('valid');
      expect(result.chainValidated).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockValidateFn).toHaveBeenCalledWith('sigok.verteiltesysteme.net', {
        resolver: expect.any(Object),
      });
    });

    it('should return bogus for a zone with invalid DNSSEC signature', async () => {
      mockValidateFn.mockResolvedValueOnce({
        status: 'BOGUS',
        reasonChain: ['SERVFAIL on RRSIG validation'],
      } as ChainVerificationResult);

      const result = await validateDnssecPerQuery('sigfail.verteiltesysteme.net', {
        timeoutMs: 5000,
        _validateFn: mockValidateFn,
      });

      expect(result.status).toBe('bogus');
      expect(result.chainValidated).toBe(false);
      expect(result.error).toContain('SERVFAIL');
    });

    it('should return insecure for an unsigned zone (no DS record)', async () => {
      mockValidateFn.mockResolvedValueOnce({
        status: 'INSECURE',
        reasonChain: ['No DS record found'],
      } as ChainVerificationResult);

      const result = await validateDnssecPerQuery('example.com', {
        timeoutMs: 5000,
        _validateFn: mockValidateFn,
      });

      expect(result.status).toBe('insecure');
      expect(result.chainValidated).toBe(false);
      expect(result.error).toContain('signed');
    });

    it('should return timeout when validation exceeds timeoutMs', async () => {
      mockValidateFn.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ status: 'SECURE' } as ChainVerificationResult), 6000),
          ),
      );

      const result = await validateDnssecPerQuery('slow.example.com', {
        timeoutMs: 100,
        _validateFn: mockValidateFn,
      });

      expect(result.status).toBe('timeout');
      expect(result.chainValidated).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should return error on network failure', async () => {
      mockValidateFn.mockRejectedValueOnce(new Error('ENOTFOUND'));

      const result = await validateDnssecPerQuery('nonexistent.example.com', {
        timeoutMs: 5000,
        _validateFn: mockValidateFn,
      });

      expect(result.status).toBe('error');
      expect(result.chainValidated).toBe(false);
      expect(result.error).toContain('ENOTFOUND');
    });

    it('should handle indeterminate status', async () => {
      mockValidateFn.mockResolvedValueOnce({
        status: 'INDETERMINATE',
        reasonChain: ['Unable to determine'],
      } as ChainVerificationResult);

      const result = await validateDnssecPerQuery('indeterminate.example.com', {
        timeoutMs: 5000,
        _validateFn: mockValidateFn,
      });

      expect(result.status).toBe('error');
      expect(result.chainValidated).toBe(false);
      expect(result.error).toContain('Unable to determine');
    });
  });
});
