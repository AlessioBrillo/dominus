import type Database from 'better-sqlite3';
import type { PipelineOrchestrator, PipelineResult } from '../pipeline/orchestrator.js';
import type { CandidateGenerationInput } from '../pipeline/stages/candidate-generation-stage.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';

export interface PersistenceSummary {
  candidatesPersisted: number;
  scoresPersisted: number;
}

export interface PipelineRunResult extends PipelineResult {
  persistence: PersistenceSummary;
}

/**
 * Application-layer coordinator that runs the pipeline and persists results.
 *
 * This is the only module that depends on both `pipeline/` and `db/` — it sits
 * above both in the module DAG. `pipeline/` and `scoring/` remain pure and
 * never import from `db/`.
 *
 * All writes happen inside a single better-sqlite3 transaction for atomicity.
 */
export class PipelineRunService {
  readonly #db: Database.Database;
  readonly #orchestrator: PipelineOrchestrator;
  readonly #candidateRepo: CandidateRepository;
  readonly #scoringRepo: ScoringRepository;

  constructor(
    db: Database.Database,
    orchestrator: PipelineOrchestrator,
    candidateRepo: CandidateRepository,
    scoringRepo: ScoringRepository,
  ) {
    this.#db = db;
    this.#orchestrator = orchestrator;
    this.#candidateRepo = candidateRepo;
    this.#scoringRepo = scoringRepo;
  }

  async run(input: CandidateGenerationInput): Promise<PipelineRunResult> {
    const result = await this.#orchestrator.run(input);

    // Persist inside a single transaction. better-sqlite3 transactions are
    // synchronous — the async pipeline work is already done above.
    const persistence = this.#db.transaction((): PersistenceSummary => {
      let candidatesPersisted = 0;
      let scoresPersisted = 0;

      // Upsert every candidate that passed through the pipeline (any status).
      // The Map keyed by domain lets us look up the persisted id for scoring rows.
      const idByDomain = new Map<string, number>();
      for (const candidate of result.allCandidates) {
        const persisted = this.#candidateRepo.upsert(candidate);
        if (persisted.id !== undefined) {
          idByDomain.set(persisted.domain, persisted.id);
        }
        candidatesPersisted++;
      }

      // Persist scores for every candidate that was evaluated by the scoring engine,
      // whether recommended, not-recommended, or TM-blocked. Partial history is
      // valuable for tuning weights against real results.
      for (const scored of result.scored) {
        const id = idByDomain.get(scored.domain);
        if (id !== undefined) {
          this.#scoringRepo.insert(id, result.runId, scored.scoreResult);
          scoresPersisted++;
        }
      }

      return { candidatesPersisted, scoresPersisted };
    })();

    return { ...result, persistence };
  }
}
