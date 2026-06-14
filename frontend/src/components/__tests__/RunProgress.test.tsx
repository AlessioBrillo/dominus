import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RunProgress } from '../RunProgress.js';

interface MockEventSourceInstance {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
}

let currentInstance: MockEventSourceInstance | null = null;

class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(_url: string) {
    currentInstance = this;
  }
}

describe('RunProgress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    currentInstance = null;
  });

  it('renders nothing when runId is null', () => {
    const { container } = render(<RunProgress runId={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows connecting state when runId is provided', () => {
    vi.stubGlobal('EventSource', MockEventSource);

    render(<RunProgress runId="test-run-123" />);
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
    expect(screen.getByText('Pipeline Progress')).toBeInTheDocument();
    expect(screen.getByText('connecting')).toBeInTheDocument();
  });

  it('renders stage events after they arrive', () => {
    vi.stubGlobal('EventSource', MockEventSource);

    render(<RunProgress runId="test-run-456" />);
    expect(currentInstance).not.toBeNull();

    act(() => {
      currentInstance!.onmessage?.({
        data: JSON.stringify({
          type: 'stage',
          runId: 'test-run-456',
          stageName: 'dns_prefilter',
          passed: 10,
          filtered: 2,
          durationMs: 1500,
          error: false,
        }),
      });
    });

    expect(screen.getByText('DNS Pre-filter')).toBeInTheDocument();
    expect(screen.getByText('+10 / -2 · 1.5s')).toBeInTheDocument();
  });

  it('renders complete state', () => {
    vi.stubGlobal('EventSource', MockEventSource);

    render(<RunProgress runId="test-run-789" />);
    expect(currentInstance).not.toBeNull();

    act(() => {
      currentInstance!.onmessage?.({
        data: JSON.stringify({
          type: 'complete',
          runId: 'test-run-789',
          totalDurationMs: 5000,
          totalPassed: 50,
          totalFiltered: 10,
          stageErrors: 0,
        }),
      });
    });

    expect(screen.getByText(/Complete/)).toBeInTheDocument();
    expect(screen.getByText(/50 passed/)).toBeInTheDocument();
  });

  it('renders error state on SSE connection failure', () => {
    vi.stubGlobal('EventSource', MockEventSource);

    render(<RunProgress runId="test-run-error" />);
    expect(currentInstance).not.toBeNull();

    act(() => {
      currentInstance!.onerror?.();
    });

    expect(screen.getByText('SSE connection failed')).toBeInTheDocument();
  });
});
