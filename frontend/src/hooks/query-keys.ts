export const queryKeys = {
  dashboard: {
    all: ['dashboard'] as const,
    stats: () => [...queryKeys.dashboard.all, 'stats'] as const,
  },
  candidates: {
    all: ['candidates'] as const,
    list: (runId?: string) => [...queryKeys.candidates.all, 'list', runId] as const,
  },
  portfolio: {
    all: ['portfolio'] as const,
    list: () => [...queryKeys.portfolio.all, 'list'] as const,
  },
  analytics: {
    all: ['analytics'] as const,
    pnl: () => [...queryKeys.analytics.all, 'pnl'] as const,
    accuracy: () => [...queryKeys.analytics.all, 'accuracy'] as const,
  },
  bids: {
    all: ['bids'] as const,
    list: () => [...queryKeys.bids.all, 'list'] as const,
  },
  outcomes: {
    all: ['outcomes'] as const,
    list: () => [...queryKeys.outcomes.all, 'list'] as const,
  },
  settings: {
    all: ['settings'] as const,
    health: () => [...queryKeys.settings.all, 'health'] as const,
    providers: () => [...queryKeys.settings.all, 'providers'] as const,
  },
  runs: {
    all: ['runs'] as const,
    list: () => [...queryKeys.runs.all, 'list'] as const,
    detail: (id?: string) => [...queryKeys.runs.all, 'detail', id] as const,
  },
  watchlist: {
    all: ['watchlist'] as const,
    list: () => [...queryKeys.watchlist.all, 'list'] as const,
  },
  backtest: {
    all: ['backtest'] as const,
    report: () => [...queryKeys.backtest.all, 'report'] as const,
  },
  scheduler: {
    all: ['scheduler'] as const,
    list: () => [...queryKeys.scheduler.all, 'list'] as const,
  },
};
