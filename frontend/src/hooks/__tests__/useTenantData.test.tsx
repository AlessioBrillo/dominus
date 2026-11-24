// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

const { mockExport, mockErase, mockLogout, mockCreateObjectURL, mockRevokeObjectURL } = vi.hoisted(
  () => ({
    mockExport: vi.fn(),
    mockErase: vi.fn(),
    mockLogout: vi.fn(),
    mockCreateObjectURL: vi.fn(() => 'blob:export'),
    mockRevokeObjectURL: vi.fn(),
  }),
);

vi.mock('@/api/tenant-data', () => ({
  exportTenantData: mockExport,
  eraseTenant: mockErase,
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ logout: mockLogout }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useEraseTenant, useExportTenantData } from '../useTenantData';
import { createWrapper } from './test-utils';

describe('useTenantData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    URL.createObjectURL = mockCreateObjectURL;
    URL.revokeObjectURL = mockRevokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  it('downloads the export as JSON and reports the row count', async () => {
    mockExport.mockResolvedValue({
      tenantId: 'tenant-a',
      generatedAt: '2026-01-01T00:00:00Z',
      formatVersion: 1,
      tables: [],
      totalRows: 3,
      retainedTables: [],
    });

    const { result } = renderHook(() => useExportTenantData(), { wrapper: createWrapper() });
    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:export');
    expect(toast.success).toHaveBeenCalledWith('Exported 3 rows');
  });

  it('reports an export failure', async () => {
    mockExport.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useExportTenantData(), { wrapper: createWrapper() });
    await act(async () => {
      result.current.mutate();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('Could not export your data');
  });

  it('signs out after a successful erasure', async () => {
    mockErase.mockResolvedValue({
      tenantId: 'tenant-a',
      deletedAt: '2026-01-01T00:00:00Z',
      tables: [],
      totalRows: 0,
      liveDataErased: true,
      subscriptionCancelled: true,
    });

    const { result } = renderHook(() => useEraseTenant(), { wrapper: createWrapper() });
    await act(async () => {
      result.current.mutate('tenant-a');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockErase).toHaveBeenCalledWith('tenant-a');
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Workspace erased');
  });

  it('warns when the subscription cancellation failed', async () => {
    mockErase.mockResolvedValue({
      tenantId: 'tenant-a',
      deletedAt: '2026-01-01T00:00:00Z',
      tables: [],
      totalRows: 0,
      liveDataErased: true,
      subscriptionCancelled: false,
    });

    const { result } = renderHook(() => useEraseTenant(), { wrapper: createWrapper() });
    await act(async () => {
      result.current.mutate('tenant-a');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith(
      'Workspace erased. Contact support about the outstanding invoice.',
    );
  });

  it('reports an erasure failure without signing out', async () => {
    mockErase.mockRejectedValue(new Error('mismatch'));
    const { result } = renderHook(() => useEraseTenant(), { wrapper: createWrapper() });
    await act(async () => {
      result.current.mutate('wrong');
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockLogout).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not erase the workspace');
  });
});
