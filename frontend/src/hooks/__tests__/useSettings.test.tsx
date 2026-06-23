import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { useHealth, useProviders } from '../useSettings';
import { api } from '@/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns health status', async () => {
    const mockHealth = {
      status: 'ok',
      uptime: 3600,
      version: '0.4.0',
      timestamp: '2026-06-23T00:00:00Z',
    };
    vi.mocked(api.get).mockResolvedValueOnce(mockHealth);

    const { result } = renderHook(() => useHealth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockHealth);
    expect(result.current.data?.status).toBe('ok');
  });

  it('handles health check failure', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Service unavailable'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHealth(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
  });
});

describe('useProviders', () => {
  it('returns provider statuses', async () => {
    const mockProviders = {
      providers: [
        { name: 'Google KW', configured: true, note: 'ok' },
        { name: 'NameBio', configured: false, note: 'no key' },
      ],
    };
    vi.mocked(api.get).mockResolvedValueOnce(mockProviders);

    const { result } = renderHook(() => useProviders(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockProviders.providers);
    expect(result.current.data).toHaveLength(2);
  });

  it('handles empty providers', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ providers: [] });
    const { result } = renderHook(() => useProviders(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });
});
