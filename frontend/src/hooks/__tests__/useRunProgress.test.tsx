import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRunProgress } from '../useRunProgress';

const instances: Array<{
  close: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  url: string;
}> = [];

class MockEventSource {
  close = vi.fn();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public url: string) {
    instances.push(this);
  }
}

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRunProgress', () => {
  it('returns idle state when runId is null', () => {
    const { result } = renderHook(() => useRunProgress(null));
    expect(result.current.status).toBe('idle');
    expect(result.current.stages).toEqual([]);
  });

  it('sets connecting status when runId is provided', async () => {
    const { result } = renderHook(() => useRunProgress('run-123'));
    await waitFor(() => {
      expect(result.current.status).toBe('connecting');
    });
  });

  it('updates state on stage event', async () => {
    const { result } = renderHook(() => useRunProgress('run-123'));

    expect(instances).toHaveLength(1);
    const es = instances[0]!;

    es.onmessage!(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'stage',
          stageName: 'DNS Pre-filter',
          passed: 50,
          filtered: 10,
          durationMs: 1200,
          error: false,
        }),
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('running');
      expect(result.current.stages).toHaveLength(1);
      expect(result.current.stages[0]?.name).toBe('DNS Pre-filter');
    });
  });

  it('marks complete on complete event', async () => {
    const { result } = renderHook(() => useRunProgress('run-123'));

    const es = instances[0]!;
    es.onmessage!(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'complete',
          totalDurationMs: 5000,
          totalPassed: 100,
          totalFiltered: 20,
        }),
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('complete');
      expect(result.current.totalDurationMs).toBe(5000);
    });
  });

  it('sets error status on SSE error event', async () => {
    const { result } = renderHook(() => useRunProgress('run-123'));

    const es = instances[0]!;
    es.onmessage!(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'error',
          message: 'Rate limit exceeded',
        }),
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('Rate limit exceeded');
    });
  });

  it('sets error status on EventSource onerror', async () => {
    const { result } = renderHook(() => useRunProgress('run-123'));

    const es = instances[0]!;
    es.onerror!(new Event('error'));

    await waitFor(() => {
      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('SSE connection failed');
    });
  });
});
