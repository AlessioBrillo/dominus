import type { DatabaseProvider } from '../db/provider/interface.js';
import {
  CandidateRepository,
  ScoringRepository,
  PortfolioRepository,
  TrademarkRepository,
  ProviderCacheRepository,
  OutcomeRepository,
  RenewalAlertRepository,
  PipelineRunsRepository,
  WatchlistRepository,
  MetricsRepository,
  JobQueueRepository,
  AcquisitionRepository,
  ListingRepository,
  TldCostRepository,
} from '../db/index.js';

export interface BuiltRepositories {
  provider: DatabaseProvider;
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
  trademarkRepo: TrademarkRepository;
  providerCacheRepo: ProviderCacheRepository;
  outcomeRepo: OutcomeRepository;
  portfolioRepo: PortfolioRepository;
  alertRepo: RenewalAlertRepository;
  pipelineRunsRepo: PipelineRunsRepository;
  metricsRepo: MetricsRepository;
  jobQueueRepo: JobQueueRepository;
  watchlistRepo: WatchlistRepository;
  acquisitionRepo: AcquisitionRepository;
  listingRepo: ListingRepository;
  tldCostRepo: TldCostRepository;
}

export function buildRepositories(provider: DatabaseProvider): BuiltRepositories {
  return {
    provider,
    candidateRepo: new CandidateRepository(provider),
    scoringRepo: new ScoringRepository(provider),
    trademarkRepo: new TrademarkRepository(provider),
    providerCacheRepo: new ProviderCacheRepository(provider),
    outcomeRepo: new OutcomeRepository(provider),
    portfolioRepo: new PortfolioRepository(provider),
    alertRepo: new RenewalAlertRepository(provider),
    pipelineRunsRepo: new PipelineRunsRepository(provider),
    metricsRepo: new MetricsRepository(provider),
    jobQueueRepo: new JobQueueRepository(provider),
    watchlistRepo: new WatchlistRepository(provider),
    acquisitionRepo: new AcquisitionRepository(provider),
    listingRepo: new ListingRepository(provider),
    tldCostRepo: new TldCostRepository(provider),
  };
}
