import type { Response } from 'express';

export interface StageProgressEvent {
  type: 'stage';
  runId: string;
  stageName: string;
  passed: number;
  filtered: number;
  durationMs: number;
  error: boolean;
}

export interface PipelineCompleteEvent {
  type: 'complete';
  runId: string;
  totalDurationMs: number;
  totalPassed: number;
  totalFiltered: number;
  stageErrors: number;
}

export interface PipelineErrorEvent {
  type: 'error';
  runId: string;
  message: string;
}

export type PipelineEvent = StageProgressEvent | PipelineCompleteEvent | PipelineErrorEvent;

export class PipelineProgressService {
  readonly #clients: Map<string, Set<Response>> = new Map();

  addClient(runId: string, res: Response): void {
    let set = this.#clients.get(runId);
    if (!set) {
      set = new Set();
      this.#clients.set(runId, set);
    }
    set.add(res);

    res.on('close', () => {
      set!.delete(res);
      if (set!.size === 0) {
        this.#clients.delete(runId);
      }
    });
  }

  broadcast(runId: string, event: PipelineEvent): void {
    const set = this.#clients.get(runId);
    if (!set || set.size === 0) return;

    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
      try {
        res.write(data);
      } catch {
        set.delete(res);
      }
    }
    if (set.size === 0) {
      this.#clients.delete(runId);
    }
  }

  removeClient(runId: string): void {
    const set = this.#clients.get(runId);
    if (!set) return;
    for (const res of set) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.#clients.delete(runId);
  }
}

export function setupSseResponse(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
}
