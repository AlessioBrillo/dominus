// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/providers', () => ({
  fetchProviderStatuses: vi.fn(),
}));

import { useProviderStatuses } from '../useProviders';
import { fetchProviderStatuses } from '@/api/providers';

const mockedFetch = vi.mocked(fetchProviderStatuses);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useProviderStatuses', () => {
  it('fetches the provider statuses', async () => {
    mockedFetch.mockResolvedValueOnce([{ name: 'dns', configured: true, note: '' }]);
    const { result } = renderHook(() => useProviderStatuses(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('surfaces a fetch error', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('status failed'));
    const { result } = renderHook(() => useProviderStatuses(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
