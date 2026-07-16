import type { DatabaseProvider } from '../db/provider/interface.js';
import type { DomainCandidate } from '../types/candidate.js';
import type { CheckpointData, CheckpointStore, StageCheckpoint } from './checkpoint-store.js';

const STAGES: string[] = [
  'CandidateGenerationStage',
  'DnsPreFilterStage',
  'RdapConfirmationStage',
  'ScoringStage',
  'TrademarkGateStage',
];

interface CheckpointRow {
  run_id: string;
  stage_name: string;
  passed_ids: string;
  filtered_ids: string;
}

function parseCandidates(json: string): DomainCandidate[] {
  try {
    return JSON.parse(json) as DomainCandidate[];
  } catch {
    return [];
  }
}

export class DbCheckpointStore implements CheckpointStore {
  constructor(private readonly db: DatabaseProvider) {}

  async save(
    runId: string,
    stageName: string,
    passed: DomainCandidate[],
    filtered: DomainCandidate[],
  ): Promise<void> {
    await this.db.exec(
      `INSERT OR REPLACE INTO pipeline_checkpoints
        (run_id, stage_name, passed_ids, filtered_ids, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))`,
      [runId, stageName, JSON.stringify(passed), JSON.stringify(filtered)],
    );
  }

  async hasCheckpoint(runId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM pipeline_checkpoints WHERE run_id = ?',
      [runId],
    );
    return (row?.cnt ?? 0) > 0;
  }

  async load(runId: string): Promise<CheckpointData | null> {
    const rows = await this.db.query<CheckpointRow>(
      'SELECT run_id, stage_name, passed_ids, filtered_ids FROM pipeline_checkpoints WHERE run_id = ? ORDER BY rowid ASC',
      [runId],
    );

    if (!rows || rows.length === 0) return null;

    const allStageResults: Record<string, StageCheckpoint> = {};
    let lastCompletedStage = '';

    for (const row of rows) {
      const passed = parseCandidates(row.passed_ids);
      const filtered = parseCandidates(row.filtered_ids);
      allStageResults[row.stage_name] = { passed, filtered, durationMs: 0 };
      lastCompletedStage = row.stage_name;
    }

    const lastResult = allStageResults[lastCompletedStage]!;
    const cumulativeFiltered: DomainCandidate[] = [];
    for (const result of Object.values(allStageResults)) {
      cumulativeFiltered.push(...result.filtered);
    }

    return {
      runId,
      lastCompletedStage,
      passed: lastResult.passed,
      filtered: cumulativeFiltered,
      allStageResults,
    };
  }

  async getLastCompletedStage(runId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ stage_name: string }>(
      'SELECT stage_name FROM pipeline_checkpoints WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
      [runId],
    );
    return row?.stage_name ?? null;
  }

  async clear(runId: string): Promise<void> {
    await this.db.exec('DELETE FROM pipeline_checkpoints WHERE run_id = ?', [runId]);
  }
}

export function getResumeIndex(lastCompletedStage: string): number {
  const idx = STAGES.indexOf(lastCompletedStage);
  if (idx === -1) return 0;
  return idx + 1;
}

export const RESUME_STAGES: readonly string[] = STAGES;
