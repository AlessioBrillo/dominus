// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  api,
  ApiError,
  clearApiKey,
  getStoredApiKey,
  setOnUnauthorized,
  storeApiKey,
} from '../client.js';

const STORAGE_KEY = 'dominus_api_key';

function mockResponse(overrides: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({}),
    ...overrides,
  } as Response;
}

function lastFetchInit(): RequestInit {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as RequestInit;
}

function lastFetchUrl(): string {
  return String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  setOnUnauthorized(() => {});
});

describe('API key storage', () => {
  it('stores, reads and clears the API key in sessionStorage', () => {
    expect(getStoredApiKey()).toBeNull();
    storeApiKey('test-key');
    expect(getStoredApiKey()).toBe('test-key');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('test-key');
    clearApiKey();
    expect(getStoredApiKey()).toBeNull();
  });

  it('returns null when sessionStorage is unavailable', () => {
    vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getStoredApiKey()).toBeNull();
  });

  it('swallows sessionStorage failures on store and clear', () => {
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(sessionStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => storeApiKey('k')).not.toThrow();
    expect(() => clearApiKey()).not.toThrow();
  });
});

describe('ApiError', () => {
  it('carries status, code, message and name', () => {
    const err = new ApiError(404, 'NOT_FOUND', 'nope');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('nope');
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('api.get', () => {
  it('prepends the base path and forwards the response JSON', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ json: async () => ({ runs: [] }) }));
    const data = await api.get<{ runs: unknown[] }>('/runs');
    expect(data).toEqual({ runs: [] });
    expect(lastFetchUrl()).toBe('/api/v1/runs');
    expect(lastFetchInit().method ?? 'GET').toBe('GET');
  });

  it('joins relative paths with a leading slash', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse());
    await api.get('runs');
    expect(lastFetchUrl()).toBe('/api/v1/runs');
  });

  it('attaches the Authorization header when an API key is stored', async () => {
    storeApiKey('secret-key');
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse());
    await api.get('/runs');
    expect((lastFetchInit().headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret-key',
    );
  });

  it('omits the Authorization header without a stored key', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse());
    await api.get('/runs');
    expect((lastFetchInit().headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('forwards an abort signal', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse());
    await api.get('/x', controller.signal);
    expect(lastFetchInit().signal).toBe(controller.signal);
  });

  it('clears the key and invokes the unauthorized handler on 401', async () => {
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    storeApiKey('expired');
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 401 }));
    await expect(api.get('/runs')).rejects.toThrow(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(getStoredApiKey()).toBeNull();
  });

  it('throws an ApiError with code UNAUTHORIZED on 403', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 403 }));
    await expect(api.get('/runs')).rejects.toMatchObject({
      status: 403,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  });

  it('surfaces the structured error from a non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: 'INTERNAL', message: 'boom' } }),
      }),
    );
    await expect(api.get('/runs')).rejects.toMatchObject({
      status: 500,
      code: 'INTERNAL',
      message: 'boom',
    });
  });

  it('falls back to the status text when the error body is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new Error('not json');
        },
      }),
    );
    await expect(api.get('/runs')).rejects.toMatchObject({
      status: 502,
      code: 'UNKNOWN',
      message: 'Bad Gateway',
    });
  });

  it('falls back to UNKNOWN when the error body lacks a code', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) }),
      );
    await expect(api.get('/runs')).rejects.toMatchObject({
      status: 400,
      code: 'UNKNOWN',
      message: 'bad',
    });
  });
});

describe('api verbs', () => {
  it('returns undefined for a 204 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 204 }));
    await expect(api.delete('/runs/1')).resolves.toBeUndefined();
  });

  it('POST serializes the body as JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ json: async () => ({ ok: 1 }) }));
    const data = await api.post('/runs', { keywords: ['a'] });
    expect(data).toEqual({ ok: 1 });
    expect(lastFetchUrl()).toBe('/api/v1/runs');
    expect(lastFetchInit().method).toBe('POST');
    expect(lastFetchInit().body).toBe(JSON.stringify({ keywords: ['a'] }));
  });

  it('POST omits the body when none is given', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse());
    await api.post('/x');
    expect(lastFetchInit().body).toBeUndefined();
  });

  it('PATCH serializes the body as JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse());
    await api.patch('/x', { ok: true });
    expect(lastFetchInit().method).toBe('PATCH');
    expect(lastFetchInit().body).toBe(JSON.stringify({ ok: true }));
  });

  it('DELETE sends the method without a body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse());
    await api.delete('/x');
    expect(lastFetchInit().method).toBe('DELETE');
  });
});
