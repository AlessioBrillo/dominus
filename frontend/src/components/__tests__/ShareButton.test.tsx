// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShareButton } from '../ShareButton.js';

vi.mock('@/api/public', () => ({
  shareScore: vi.fn(),
}));

import { shareScore } from '@/api/public';
import type { ShareScoreResponse } from '@/api/public';

const mockedShareScore = vi.mocked(shareScore);
const writeText = vi.fn().mockResolvedValue(undefined);

function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('ShareButton', () => {
  it('shares the score and copies the URL to the clipboard', async () => {
    mockedShareScore.mockResolvedValueOnce({
      slug: 'example-com',
      url: '/score/example.com',
      domain: 'example.com',
    });
    render(<ShareButton domain="example.com" />);

    fireEvent.click(screen.getByRole('button', { name: /share/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/score/example.com`),
    );
    await waitFor(() => expect(screen.getByText('Copied!')).toBeInTheDocument());
  });

  it('renders a loading state while sharing', async () => {
    const { promise, resolve } = deferred();
    mockedShareScore.mockReturnValueOnce(promise as Promise<ShareScoreResponse>);
    render(<ShareButton domain="example.com" />);

    fireEvent.click(screen.getByRole('button', { name: /share/i }));

    const button = screen.getByRole('button', { name: /share/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    resolve({ slug: 'x', url: '/s', domain: 'example.com' });
    await waitFor(() => expect(screen.getByText('Copied!')).toBeInTheDocument());
  });

  it('logs and recovers when sharing fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedShareScore.mockRejectedValueOnce(new Error('boom'));
    render(<ShareButton domain="example.com" />);

    fireEvent.click(screen.getByRole('button', { name: /share/i }));

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /share/i })).not.toBeDisabled();
    consoleError.mockRestore();
  });
});
