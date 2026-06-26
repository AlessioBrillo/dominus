import type { DatabaseProvider } from './interface.js';

export const PG_MIGRATIONS: Array<{ name: string; up: (db: DatabaseProvider) => Promise<void> }> = [
  {
    name: '0001_create_candidates',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS candidates (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL UNIQUE,
          tld TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          dns_status TEXT,
          rdap_status TEXT,
          is_premium INTEGER NOT NULL DEFAULT 0,
          pipeline_run_id TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_candidates_domain ON candidates(domain)');
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_candidates_pipeline_run ON candidates(pipeline_run_id)',
      );
    },
  },
  {
    name: '0002_create_scoring_runs',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS scoring_runs (
          id SERIAL PRIMARY KEY,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          run_id TEXT NOT NULL,
          expected_value REAL NOT NULL,
          confidence REAL NOT NULL,
          suggested_buy_max REAL NOT NULL,
          suggested_list_price REAL NOT NULL,
          intrinsic_score REAL NOT NULL,
          commercial_score REAL NOT NULL,
          market_score REAL NOT NULL,
          expiry_score REAL NOT NULL,
          weighted_score REAL NOT NULL DEFAULT 0,
          recommended INTEGER NOT NULL DEFAULT 0,
          signal_scores TEXT NOT NULL,
          scored_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_scoring_runs_candidate ON scoring_runs(candidate_id)',
      );
    },
  },
  {
    name: '0003_create_portfolio',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS portfolio_entries (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL UNIQUE,
          tld TEXT NOT NULL,
          acquired_at TIMESTAMP NOT NULL,
          renewal_date TIMESTAMP NOT NULL,
          acquisition_cost REAL NOT NULL,
          renewal_cost REAL NOT NULL,
          registrar TEXT NOT NULL,
          current_score REAL,
          suggested_list_price REAL,
          verdict TEXT NOT NULL DEFAULT 'keep',
          verdict_reason TEXT,
          verdict_updated_at TIMESTAMP,
          notes TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    name: '0004_create_trademark',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS trademark_results (
          id SERIAL PRIMARY KEY,
          candidate_id INTEGER REFERENCES candidates(id),
          search_term TEXT NOT NULL,
          source TEXT NOT NULL,
          match_found INTEGER NOT NULL,
          match_details TEXT,
          raw_response TEXT,
          checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_trademark_candidate ON trademark_results(candidate_id, source)',
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_trademark_term ON trademark_results(search_term, source)',
      );
    },
  },
  {
    name: '0005_trademark_term_cache',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS trademark_term_cache (
          id SERIAL PRIMARY KEY,
          term TEXT NOT NULL,
          source TEXT NOT NULL,
          results_json TEXT NOT NULL,
          checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL
        )
      `);
      await db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_trademark_term_cache_lookup ON trademark_term_cache(term, source)',
      );
    },
  },
  {
    name: '0006_create_outcomes',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS outcomes (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL REFERENCES portfolio_entries(domain) ON DELETE CASCADE,
          type TEXT NOT NULL,
          occurred_at TIMESTAMP NOT NULL,
          sale_price_eur REAL,
          listing_price_eur REAL,
          days_listed INTEGER,
          venue TEXT,
          commission_pct REAL,
          acquisition_cost_eur REAL,
          total_renewal_cost_eur REAL,
          notes TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_outcomes_domain ON outcomes(domain)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_outcomes_type ON outcomes(type, occurred_at)');
    },
  },
  {
    name: '0007_create_backtest_signals',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS backtest_signals (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL,
          outcome_id INTEGER NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
          scoring_run_id TEXT NOT NULL,
          predicted_expected_value REAL NOT NULL,
          predicted_buy_max REAL NOT NULL,
          predicted_list_price REAL NOT NULL,
          predicted_confidence REAL NOT NULL,
          actual_sale_price_eur REAL NOT NULL,
          absolute_error_eur REAL NOT NULL,
          signed_error_eur REAL NOT NULL,
          confidence_bucket TEXT NOT NULL,
          acquisition_cost_eur REAL NOT NULL DEFAULT 0,
          total_renewal_cost_paid_eur REAL NOT NULL DEFAULT 0,
          recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_backtest_outcome ON backtest_signals(outcome_id)',
      );
      await db.exec('CREATE INDEX IF NOT EXISTS idx_backtest_domain ON backtest_signals(domain)');
      await db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_backtest_outcome_run ON backtest_signals(outcome_id, scoring_run_id)',
      );
    },
  },
  {
    name: '0008_create_pipeline_runs',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_runs (
          run_id TEXT PRIMARY KEY,
          started_at TIMESTAMP NOT NULL,
          finished_at TIMESTAMP,
          total_duration_ms INTEGER,
          stage_summary TEXT NOT NULL DEFAULT '{}',
          inputs TEXT NOT NULL DEFAULT '{}',
          results_summary TEXT NOT NULL DEFAULT '{}',
          host_version TEXT NOT NULL,
          retained_until TIMESTAMP NOT NULL,
          error TEXT
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at ON pipeline_runs(started_at DESC)',
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_pipeline_runs_retained_until ON pipeline_runs(retained_until)',
      );
    },
  },
  {
    name: '0009_create_renewal_alerts',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS renewal_alerts (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL,
          portfolio_entry_id INTEGER NOT NULL REFERENCES portfolio_entries(id) ON DELETE CASCADE,
          alert_type TEXT NOT NULL CHECK(alert_type IN ('renewal_imminent','renewal_critical','renewal_past_due','score_dropped')),
          severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
          message TEXT NOT NULL,
          details TEXT,
          acknowledged_at TIMESTAMP,
          notified_channels TEXT NOT NULL DEFAULT '[]',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_renewal_alerts_domain ON renewal_alerts(domain)',
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_renewal_alerts_unack ON renewal_alerts(acknowledged_at)',
      );
      await db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_renewal_alerts_domain_type ON renewal_alerts(domain, alert_type)',
      );
    },
  },
  {
    name: '0010_create_watchlist',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS watchlist_entries (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL UNIQUE,
          tld TEXT NOT NULL,
          notes TEXT,
          last_checked_at TIMESTAMP,
          last_status TEXT,
          last_status_change TEXT,
          notified INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_watchlist_checked_at ON watchlist_entries(last_checked_at)',
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_watchlist_notified ON watchlist_entries(notified)',
      );
    },
  },
  {
    name: '0011_rename_weights_snapshot',
    up: async (): Promise<void> => {},
  },
  {
    name: '0012_create_weight_snapshots',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS weight_snapshots (
          id SERIAL PRIMARY KEY,
          snapshot_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          intrinsic REAL NOT NULL,
          commercial REAL NOT NULL,
          market REAL NOT NULL,
          expiry REAL NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('init', 'manual', 'auto-tune', 'cli-override')),
          backtest_generated_at TIMESTAMP,
          sample_size INTEGER,
          notes TEXT
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_weight_snapshots_snapshot_at ON weight_snapshots(snapshot_at DESC)',
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_weight_snapshots_source ON weight_snapshots(source)',
      );
    },
  },
  {
    name: '0013_create_provider_cache',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS provider_cache (
          id SERIAL PRIMARY KEY,
          cache_key TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL
        )
      `);
      await db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_cache_lookup ON provider_cache(cache_key, provider_name)',
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_provider_cache_expires ON provider_cache(expires_at)',
      );
    },
  },
  {
    name: '0014_create_scheduler_jobs',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS scheduler_jobs (
          job_name TEXT PRIMARY KEY,
          cron_expression TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TIMESTAMP,
          last_result TEXT,
          last_duration_ms INTEGER,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_enabled ON scheduler_jobs(enabled)',
      );
    },
  },
  {
    name: '0015_fix_scoring_runs_trademark_constraints',
    up: async (): Promise<void> => {},
  },
  {
    name: '0016_add_backtest_costs',
    up: async (): Promise<void> => {},
  },
  {
    name: '0017_add_pipeline_run_index',
    up: async (): Promise<void> => {},
  },
  {
    name: '0018_create_pipeline_metrics',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_metrics (
          id SERIAL PRIMARY KEY,
          pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          stage_name TEXT NOT NULL,
          passed INTEGER NOT NULL DEFAULT 0,
          filtered INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          error INTEGER NOT NULL DEFAULT 0,
          recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(pipeline_run_id, stage_name)
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_run ON pipeline_metrics(pipeline_run_id)',
      );
    },
  },
  {
    name: '0019_add_scoring_run_recommended',
    up: async (): Promise<void> => {},
  },
  {
    name: '0020_create_outcome_scores',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS outcome_scores (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL,
          outcome_type TEXT NOT NULL,
          recommended INTEGER NOT NULL DEFAULT 0,
          weighted_score REAL NOT NULL DEFAULT 0,
          confidence REAL NOT NULL DEFAULT 0,
          expected_value REAL NOT NULL DEFAULT 0,
          actual_sale_price REAL,
          tld TEXT NOT NULL,
          scored_at TIMESTAMP NOT NULL,
          occurred_at TIMESTAMP NOT NULL,
          commercial_score REAL NOT NULL DEFAULT 0,
          market_score REAL NOT NULL DEFAULT 0,
          expiry_score REAL NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(domain, occurred_at)
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_outcome_scores_occurred ON outcome_scores(occurred_at DESC)',
      );
      await db.exec('CREATE INDEX IF NOT EXISTS idx_outcome_scores_tld ON outcome_scores(tld)');
    },
  },
  {
    name: '0021_create_bids',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS bids (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL,
          venue TEXT NOT NULL,
          bid_amount_eur REAL NOT NULL,
          max_bid_eur REAL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','won','lost','cancelled','outbid')),
          won_price_eur REAL,
          expected_value_at_bid REAL,
          confidence_at_bid REAL,
          suggested_buy_max_at_bid REAL,
          trademark_clear_at_bid INTEGER,
          bid_placed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          auction_ends_at TIMESTAMP,
          resolved_at TIMESTAMP,
          notes TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_bids_domain ON bids(domain)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_bids_status ON bids(status)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_bids_placed_at ON bids(bid_placed_at)');
    },
  },
  {
    name: '0022_create_job_queue',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id SERIAL PRIMARY KEY,
          job_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','dead_letter')),
          priority INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          scheduled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          started_at TIMESTAMP,
          finished_at TIMESTAMP,
          error TEXT,
          result_json TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_job_queue_status_priority_scheduled ON job_queue(status, priority DESC, scheduled_at)',
      );
      await db.exec('CREATE INDEX IF NOT EXISTS idx_job_queue_job_type ON job_queue(job_type)');
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_job_queue_created_at ON job_queue(created_at DESC)',
      );
      await db.exec(`
        CREATE TABLE IF NOT EXISTS dead_letter_jobs (
          id SERIAL PRIMARY KEY,
          original_job_id INTEGER NOT NULL,
          job_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          error TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          failed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          original_created_at TIMESTAMP NOT NULL
        )
      `);
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_dead_letter_job_type ON dead_letter_jobs(job_type)',
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_dead_letter_failed_at ON dead_letter_jobs(failed_at DESC)',
      );
    },
  },
  {
    name: '0023_add_outcome_costs',
    up: async (): Promise<void> => {},
  },
  {
    name: '0024_create_listings',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS listings (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL,
          marketplace TEXT NOT NULL,
          listing_url TEXT,
          list_price_eur REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','listed','pending','sold','cancelled','expired')),
          external_id TEXT,
          score_snapshot_json TEXT,
          listed_at TIMESTAMP,
          sold_at TIMESTAMP,
          sold_price_eur REAL,
          notes TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_listings_domain ON listings(domain)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_listings_marketplace ON listings(marketplace)');
    },
  },
  {
    name: '0025_create_events_and_onboarding',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id SERIAL PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          anon_id TEXT,
          type TEXT NOT NULL,
          props TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at)');
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id, created_at DESC)',
      );
      await db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding_state (
          tenant_id TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
          current_step TEXT NOT NULL DEFAULT 'welcome',
          step_data TEXT,
          completed_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    name: '0026_create_public_scores',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS public_scores (
          slug TEXT NOT NULL PRIMARY KEY,
          domain TEXT NOT NULL,
          score_json TEXT NOT NULL,
          trademark_json TEXT,
          view_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_public_scores_domain ON public_scores(domain)');
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_public_scores_created ON public_scores(created_at DESC)',
      );
    },
  },
  {
    name: '0027_create_wayback_cache',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS wayback_cache (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL UNIQUE,
          cached_json TEXT,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    name: '0028_create_auto_listings',
    up: async (db): Promise<void> => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS auto_listings (
          id SERIAL PRIMARY KEY,
          domain TEXT NOT NULL,
          portfolio_entry_id INTEGER,
          listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
          trigger_source TEXT NOT NULL CHECK(trigger_source IN ('acquisition','purchase','pipeline_run','manual')),
          pipeline_run_id TEXT,
          score_snapshot_json TEXT,
          auto_listed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','cancelled'))
        )
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_auto_listings_domain ON auto_listings(domain)');
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_auto_listings_listing ON auto_listings(listing_id)',
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_auto_listings_source ON auto_listings(trigger_source)',
      );
    },
  },
];
