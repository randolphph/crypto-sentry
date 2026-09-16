ALTER TABLE processed_metric_events ADD COLUMN status TEXT NOT NULL DEFAULT 'processed';
ALTER TABLE processed_metric_events ADD COLUMN processing_started_at TEXT;
ALTER TABLE processed_metric_events ADD COLUMN processed_at TEXT;
ALTER TABLE processed_metric_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
UPDATE processed_metric_events SET processed_at = received_at WHERE status = 'processed';
CREATE TABLE rule_event_commits (
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (rule_id, event_id, metric_name)
);
CREATE TABLE uniswap_indexer_states (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error_code TEXT,
  last_attempt_at TEXT NOT NULL,
  chunk_size TEXT NOT NULL,
  PRIMARY KEY (integration_id, chain_id, version)
);
CREATE TABLE uniswap_pool_swap_samples (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  token0_volume TEXT NOT NULL,
  token1_volume TEXT NOT NULL,
  usd_volume TEXT,
  PRIMARY KEY (monitor_id, event_id)
);
CREATE INDEX uniswap_pool_swap_samples_time_idx
  ON uniswap_pool_swap_samples(monitor_id, observed_at);
