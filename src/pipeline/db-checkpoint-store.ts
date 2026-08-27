// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../db/provider/interface.js';
import type { DomainCandidate } from '../types/candidate.js';
import { getLogger } from '../logger.js';
import type { CheckpointData, CheckpointStore, StageCheckpoint } from './checkpoint-store.js';
import {
  CHECKPOINT_FORMAT_VERSION,
  CHECKPOINT_MAX_AGE_MS,
  validateCandidate,
} from './checkpoint-store.js';

const logger = getLogger();

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
  format_version: number;
  created_at: string;
}

function parseCandidates(json: string): DomainCandidate[] {
  try {
    return JSON.parse(json) as DomainCandidate[];
  } catch {
    return [];
  }
}

/**
 * Parse checkpoint timestamps across dialects: SQLite CURRENT_TIMESTAMP
 * yields 'YYYY-MM-DD HH:MM:SS' (UTC, no offset), PostgreSQL yields an ISO
 * string with offset. The space-form would parse as LOCAL time on V8, so
 * it is normalised to UTC explicitly.
 */
function parseCheckpointDate(raw: string | undefined): number {
  if (!raw) return 0;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}

export class DbCheckpointStore implements CheckpointStore {
  constructor(private readonly db: DatabaseProvider) {}

  async save(
    runId: string,
    stageName: string,
    passed: DomainCandidate[],
    filtered: DomainCandidate[],
  ): Promise<void> {
    // Dialect-neutral upsert: ON CONFLICT ... DO UPDATE and CURRENT_TIMESTAMP
    // work on both SQLite and PostgreSQL (no INSERT OR REPLACE / datetime()).
    await this.db.exec(
      `INSERT INTO pipeline_checkpoints
        (run_id, stage_name, passed_ids, filtered_ids, format_version, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(run_id, stage_name) DO UPDATE SET
        passed_ids = excluded.passed_ids,
        filtered_ids = excluded.filtered_ids,
        format_version = excluded.format_version,
        created_at = CURRENT_TIMESTAMP`,
      [
        runId,
        stageName,
        JSON.stringify(passed),
        JSON.stringify(filtered),
        CHECKPOINT_FORMAT_VERSION,
      ],
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
      'SELECT run_id, stage_name, passed_ids, filtered_ids, format_version, created_at FROM pipeline_checkpoints WHERE run_id = ? ORDER BY id ASC',
      [runId],
    );

    if (!rows || rows.length === 0) return null;

    // Ignore checkpoints written by a different binary: format drift or a
    // version bump means the payload semantics may differ (stale verdicts
    // must never be replayed under new logic).
    if (rows.some((row) => row.format_version !== CHECKPOINT_FORMAT_VERSION)) {
      logger.warn(
        { runId, versions: [...new Set(rows.map((r) => r.format_version))] },
        'Pipeline checkpoint format version mismatch — ignoring checkpoint, starting fresh',
      );
      return null;
    }

    // Ignore stale checkpoints: an old resume would replay DNS/RDAP verdicts
    // from before the last deploy.
    const newest = rows[rows.length - 1]!;
    const ageMs = Date.now() - parseCheckpointDate(newest.created_at);
    if (ageMs > CHECKPOINT_MAX_AGE_MS) {
      logger.warn(
        { runId, ageMs },
        'Pipeline checkpoint is older than 24h — ignoring, starting fresh',
      );
      return null;
    }

    const allStageResults: Record<string, StageCheckpoint> = {};
    let lastCompletedStage = '';

    for (const row of rows) {
      const passed = parseCandidates(row.passed_ids).filter((c) =>
        validateCandidate(c, CHECKPOINT_FORMAT_VERSION),
      );
      const filtered = parseCandidates(row.filtered_ids).filter((c) =>
        validateCandidate(c, CHECKPOINT_FORMAT_VERSION),
      );
      allStageResults[row.stage_name] = {
        passed,
        filtered,
        durationMs: 0,
        formatVersion: row.format_version,
      };
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
      formatVersion: CHECKPOINT_FORMAT_VERSION,
    };
  }

  async getLastCompletedStage(runId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ stage_name: string }>(
      'SELECT stage_name FROM pipeline_checkpoints WHERE run_id = ? ORDER BY id DESC LIMIT 1',
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
