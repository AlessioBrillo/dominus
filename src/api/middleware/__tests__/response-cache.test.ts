import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { responseCache } from '../response-cache.js';

describe('responseCache', () => {
  it('sets Cache-Control header on GET requests', () => {
    const set = vi.fn();
    const req = { method: 'GET' } as Request;
    const res = { set } as unknown as Response;
    const next = vi.fn();

    responseCache(60)(req, res, next);

    expect(set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=60');
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses default 60s TTL when not specified', () => {
    const set = vi.fn();
    const req = { method: 'GET' } as Request;
    const res = { set } as unknown as Response;
    const next = vi.fn();

    responseCache()(req, res, next);

    expect(set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=60');
  });

  it('accepts custom TTL', () => {
    const set = vi.fn();
    const req = { method: 'GET' } as Request;
    const res = { set } as unknown as Response;
    const next = vi.fn();

    responseCache(300)(req, res, next);

    expect(set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=300');
  });

  it('does not set Cache-Control on non-GET requests', () => {
    const set = vi.fn();
    const req = { method: 'POST' } as Request;
    const res = { set } as unknown as Response;
    const next = vi.fn();

    responseCache(60)(req, res, next);

    expect(set).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
