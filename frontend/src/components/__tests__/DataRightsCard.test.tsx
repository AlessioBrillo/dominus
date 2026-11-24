// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockExportMutate, mockEraseMutate } = vi.hoisted(() => ({
  mockExportMutate: vi.fn(),
  mockEraseMutate: vi.fn(),
}));

vi.mock('@/hooks/useMe', () => ({
  useMe: () => ({ me: { tenantId: 'tenant-abc', role: 'admin' } }),
}));

vi.mock('@/hooks/useTenantData', () => ({
  useExportTenantData: () => ({ mutate: mockExportMutate, isPending: false }),
  useEraseTenant: () => ({ mutate: mockEraseMutate, isPending: false }),
}));

import { DataRightsCard } from '../DataRightsCard';

describe('DataRightsCard', () => {
  beforeEach(() => {
    mockExportMutate.mockClear();
    mockEraseMutate.mockClear();
  });

  it('offers both rights without a support ticket', () => {
    render(<DataRightsCard />);
    expect(screen.getByRole('button', { name: /download my data/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /erase my workspace/i })).toBeInTheDocument();
  });

  it('exports the workspace on demand', () => {
    render(<DataRightsCard />);
    fireEvent.click(screen.getByRole('button', { name: /download my data/i }));
    expect(mockExportMutate).toHaveBeenCalledTimes(1);
  });

  it('requires the typed tenant id before erasing', () => {
    render(<DataRightsCard />);
    fireEvent.click(screen.getByRole('button', { name: /erase my workspace/i }));

    const input = screen.getByLabelText('Workspace id to confirm');
    const confirm = screen.getByRole('button', { name: /erase everything/i });
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: 'wrong-id' } });
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: 'tenant-abc' } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    expect(mockEraseMutate).toHaveBeenCalledWith('tenant-abc');
  });
});
