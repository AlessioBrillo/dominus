import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { securityHeaders } from '../security-headers.js';

function mockReq(path: string, proto = 'http', forwardedProto?: string): Request {
  return {
    path,
    protocol: proto,
    headers: {
      'x-forwarded-proto': forwardedProto,
    },
  } as unknown as Request;
}

function mockRes(): Response {
  const headers = new Map<string, string>();
  return {
    setHeader: vi.fn((key: string, value: string) => {
      headers.set(key.toLowerCase(), value);
    }),
    getHeader: (key: string) => headers.get(key.toLowerCase()),
  } as unknown as Response;
}

describe('securityHeaders', () => {
  it('sets all security headers for API requests', () => {
    const req = mockReq('/api/v1/health');
    const res = mockRes();
    const next = vi.fn();

    securityHeaders(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '0');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Referrer-Policy',
      'strict-origin-when-cross-origin',
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-DNS-Prefetch-Control', 'off');
    expect(res.setHeader).toHaveBeenCalledWith('Cross-Origin-Opener-Policy', 'same-origin');
    expect(res.setHeader).toHaveBeenCalledWith('Cross-Origin-Resource-Policy', 'same-origin');
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses strict CSP for API paths', () => {
    const req = mockReq('/api/v1/score');
    const res = mockRes();
    const next = vi.fn();

    securityHeaders(req, res, next);

    const csp = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.find(
      ([k]: string[]) => k === 'Content-Security-Policy',
    )?.[1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src 'self'");
  });

  it('uses SPA CSP for non-API paths', () => {
    const req = mockReq('/');
    const res = mockRes();
    const next = vi.fn();

    securityHeaders(req, res, next);

    const csp = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.find(
      ([k]: string[]) => k === 'Content-Security-Policy',
    )?.[1];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("default-src 'none'");
  });

  it('sets HSTS header when request is HTTPS', () => {
    const req = mockReq('/api/v1/health', 'https');
    const res = mockRes();
    const next = vi.fn();

    securityHeaders(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  });

  it('sets HSTS header when x-forwarded-proto is https', () => {
    const req = mockReq('/api/v1/health', 'http', 'https');
    const res = mockRes();
    const next = vi.fn();

    securityHeaders(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Strict-Transport-Security', expect.any(String));
  });

  it('does not set HSTS on plain HTTP', () => {
    const req = mockReq('/api/v1/health', 'http');
    const res = mockRes();
    const next = vi.fn();

    securityHeaders(req, res, next);

    const calls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]);
    expect(calls).not.toContain('Strict-Transport-Security');
  });

  it('sets Permissions-Policy restricting all sensitive features', () => {
    const req = mockReq('/');
    const res = mockRes();
    const next = vi.fn();

    securityHeaders(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    );
  });

  it('calls next() to continue the middleware chain', () => {
    const req = mockReq('/api/v1/health');
    const res = mockRes();
    const next = vi.fn();

    securityHeaders(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });
});
