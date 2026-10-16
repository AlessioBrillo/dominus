// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/automation', () => ({
  getAutomationSettings: vi.fn(),
  getAutomationSteps: vi.fn(),
  getAutomationAudit: vi.fn(),
  updateAutomationSettings: vi.fn(),
  runAutomation: vi.fn(),
  resetAutomation: vi.fn(),
}));

import { AutomationPage } from '../AutomationPage';
import {
  getAutomationAudit,
  getAutomationSettings,
  getAutomationSteps,
  updateAutomationSettings,
} from '@/api/automation';

const settings = {
  global: { enabled: true, dryRun: true },
  tenant: { enabled: false, dryRun: true },
  effective: { enabled: false, dryRun: true, refusedBy: 'tenant_switch' as const },
};

const step = {
  id: 1,
  domain: 'vintagecoffee.com',
  step: 'listing' as const,
  status: 'done' as const,
  attempts: 1,
  source: 'purchase',
  pipelineRunId: null,
  detailJson: null,
  lastError: null,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
};

const auditEntry = {
  id: 1,
  action: 'step_site_done',
  domain: 'vintagecoffee.com',
  actor: 'purchase',
  detailJson: null,
  createdAt: '2026-10-01T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAutomationSettings).mockResolvedValue({ settings });
  vi.mocked(getAutomationSteps).mockResolvedValue({ steps: [step] });
  vi.mocked(getAutomationAudit).mockResolvedValue({ entries: [auditEntry] });
});

describe('AutomationPage', () => {
  it('renders the title and the tenant switch state', async () => {
    render(<AutomationPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Automation')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/your own switch for the automated lifecycle/i)).toBeInTheDocument(),
    );
    // The tenant is opted out: the Automation "Off" button is pressed.
    expect(screen.getByRole('button', { name: 'Off', pressed: true })).toBeInTheDocument();
  });

  it('shows the kill switch banner when the global switch is off', async () => {
    vi.mocked(getAutomationSettings).mockResolvedValue({
      settings: {
        ...settings,
        global: { enabled: false, dryRun: false },
        effective: { enabled: false, dryRun: false, refusedBy: 'global_kill_switch' as const },
      },
    });
    render(<AutomationPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText(/runs are refused/i)).toBeInTheDocument());
  });

  it('does not show the kill switch banner when the global switch is on', async () => {
    render(<AutomationPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByRole('group', { name: 'Automation' })).toBeVisible());
    expect(screen.queryByText(/operator kill switch is off/i)).not.toBeInTheDocument();
  });

  it('enables automation when the On button is clicked', async () => {
    vi.mocked(updateAutomationSettings).mockResolvedValue({ settings });
    render(<AutomationPage />, { wrapper: createWrapper() });

    const group = await screen.findByRole('group', { name: 'Automation' });
    fireEvent.click(group.querySelector('button')!);

    await waitFor(() => expect(updateAutomationSettings).toHaveBeenCalledWith({ enabled: true }));
  });

  it('renders the step journal rows', async () => {
    render(<AutomationPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getAllByText('vintagecoffee.com')).toHaveLength(2));
    expect(screen.getByText('listing')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /run pipeline for vintagecoffee.com/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /reset pipeline for vintagecoffee.com/i }),
    ).toBeInTheDocument();
  });

  it('renders the audit trail entries', async () => {
    render(<AutomationPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('step_site_done')).toBeInTheDocument());
    expect(screen.getByText('purchase')).toBeInTheDocument();
  });

  it('shows the empty state when no steps exist', async () => {
    vi.mocked(getAutomationSteps).mockResolvedValue({ steps: [] });
    render(<AutomationPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('No pipeline steps yet')).toBeInTheDocument());
  });

  it('shows an error card when settings fail to load', async () => {
    vi.mocked(getAutomationSettings).mockRejectedValueOnce(new Error('settings unavailable'));
    render(<AutomationPage />, { wrapper: createWrapper() });

    expect(await screen.findByText('settings unavailable')).toBeInTheDocument();
  });
});
