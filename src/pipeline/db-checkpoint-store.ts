import type { DatabaseProvider } from '../db/provider/interface.js';
import type { DomainCandidate } from '../types/candidate.js';
import type { CheckpointData, CheckpointStore } from './checkpoint-store.js';

const STAGES = [
  'CandidateGenerationStage',
  'DnsPreFilterStage',
  'RdapConfirmationStage',
  'ScoringStage',
  'TrademarkGateStage',
];

export class DbCheckpointStore implements CheckpointStore {
  constructor(private readonly db: DatabaseProvider) {}

  async save(
    runId: string,
    stageName: string,
    _passed: DomainCandidate[],
    filtered: DomainCandidate[],
    _stageDurationMs: number,
    cumulativePassed: DomainCandidate[],
    cumulativeFiltered: DomainCandidate[],
  ): Promise<void> {
    await this.db.exec(
      `INSERT OR REPLACE INTO pipeline_checkpoints
        (run_id, stage_name, passed_ids, filtered_ids, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))`,
      [
        runId,
        stageName,
        JSON.stringify(cumulativePassed.map((c) => c.domain)),
        JSON.stringify([...cumulativeFiltered, ...filtered].map((c) => c.domain)),
      ],
    );
  }

  async load(runId: string): Promise<CheckpointData | null> {
    const row = await this.db.queryOne<{
      run_id: string;
      stage_name: string;
      passed_ids: string;
      filtered_ids: string;
    }>(
      'SELECT run_id, stage_name, passed_ids, filtered_ids FROM pipeline_checkpoints WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
      [runId],
    );

    if (!row) return null;

    return {
      runId: row.run_id,
      lastCompletedStage: row.stage_name,
      passed: [],
      filtered: [],
      allStageResults: {},
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
