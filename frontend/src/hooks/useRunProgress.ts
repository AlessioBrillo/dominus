// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, useRef } from 'react';
import { getStoredApiKey } from '@/api/client';

export interface StageInfo {
  name: string;
  passed: number;
  filtered: number;
  durationMs: number;
  error: boolean;
  complete: boolean;
}

export interface RunProgressState {
  stages: StageInfo[];
  status: 'idle' | 'connecting' | 'running' | 'complete' | 'error';
  totalDurationMs?: number;
  totalPassed?: number;
  totalFiltered?: number;
  error?: string;
}

export function useRunProgress(runId: string | null): RunProgressState {
  const [state, setState] = useState<RunProgressState>({
    stages: [],
    status: 'idle',
  });
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) {
      setState({ stages: [], status: 'idle' });
      return;
    }

    setState({ stages: [], status: 'connecting' });

    // EventSource cannot set custom headers, so we pass the API key via
    // the `token` query parameter. The auth middleware reads this as a
    // fallback when no Authorization header is present.
    const apiKey = getStoredApiKey();
    const tokenParam = apiKey ? `?token=${encodeURIComponent(apiKey)}` : '';
    const es = new EventSource(`/api/v1/runs/${runId}/stream${tokenParam}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'stage') {
          setState((prev) => {
            const existing = prev.stages.findIndex((s) => s.name === data.stageName);
            const stage: StageInfo = {
              name: data.stageName,
              passed: data.passed,
              filtered: data.filtered,
              durationMs: data.durationMs,
              error: data.error,
              complete: true,
            };
            const stages =
              existing >= 0
                ? prev.stages.map((s, i) => (i === existing ? stage : s))
                : [...prev.stages, stage];
            return { ...prev, stages, status: 'running' };
          });
        } else if (data.type === 'complete') {
          setState((prev) => ({
            ...prev,
            status: 'complete',
            totalDurationMs: data.totalDurationMs,
            totalPassed: data.totalPassed,
            totalFiltered: data.totalFiltered,
          }));
        } else if (data.type === 'error') {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: data.message,
          }));
        }
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: 'SSE connection failed',
      }));
      es.close();
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [runId]);

  return state;
}
