const STORAGE_KEY = 'dominus_api_key';
const BASE_URL = '/api/v1';

export function getStoredApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeApiKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* non-fatal */
  }
}

export function clearApiKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const apiKey = getStoredApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const outerSignal = options.signal as AbortSignal | undefined;

  const url = path.startsWith('/') ? `${BASE_URL}${path}` : `${BASE_URL}/${path}`;

  const res = await fetch(url, { ...options, signal: outerSignal, headers });

  if (res.status === 401 || res.status === 403) {
    clearApiKey();
    onUnauthorized?.();
    throw new ApiError(res.status, 'UNAUTHORIZED', 'Authentication required');
  }

  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined, signal }),
  delete: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'DELETE', signal }),
};
