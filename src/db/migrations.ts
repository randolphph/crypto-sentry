import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export const migrations = [
  {
    name: '0000_initial',
    sql: `
CREATE TABLE integrations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE monitors (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_seconds INTEGER NOT NULL DEFAULT 20,
  max_stale_seconds INTEGER NOT NULL DEFAULT 90,
  config_json TEXT NOT NULL,
  last_status TEXT NOT NULL DEFAULT 'warming_up',
  last_data_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX monitors_enabled_idx ON monitors(enabled);
CREATE TABLE rules (
  id TEXT PRIMARY KEY NOT NULL,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL,
  threshold TEXT NOT NULL,
  window_seconds INTEGER,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  cooldown_seconds INTEGER NOT NULL DEFAULT 1800,
  hysteresis TEXT NOT NULL DEFAULT '0',
  severity TEXT NOT NULL,
  notification_integration_ids_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX rules_monitor_id_idx ON rules(monitor_id);
CREATE TABLE rule_states (
  rule_id TEXT PRIMARY KEY NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'ARMED',
  condition_since TEXT,
  last_value TEXT,
  last_alert_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE alerts (
  id TEXT PRIMARY KEY NOT NULL,
  rule_id TEXT REFERENCES rules(id) ON DELETE SET NULL,
  monitor_id TEXT REFERENCES monitors(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  metric_name TEXT,
  current_value TEXT,
  threshold TEXT,
  observed_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  delivery_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX alerts_status_created_at_idx ON alerts(status, created_at);
CREATE INDEX alerts_rule_id_idx ON alerts(rule_id);
CREATE TABLE price_samples (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  price TEXT NOT NULL,
  PRIMARY KEY (monitor_id, observed_at)
);
CREATE INDEX price_samples_observed_at_idx ON price_samples(observed_at);
`,
  },
  {
    name: '0001_integration_markets',
    sql: `
CREATE TABLE integration_markets (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  market_type TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  canonical_symbol TEXT NOT NULL,
  base_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, market_type, provider_symbol)
);
CREATE INDEX integration_markets_canonical_idx
  ON integration_markets(integration_id, canonical_symbol);
`,
  },
  {
    name: '0002_rule_labels',
    sql: `
ALTER TABLE rules ADD COLUMN labels_json TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    name: '0003_uniswap_v4_ownership_index',
    sql: `
CREATE TABLE uniswap_v4_scan_checkpoints (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  position_manager_address TEXT NOT NULL,
  last_scanned_block TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, wallet_address, position_manager_address)
);
CREATE TABLE uniswap_v4_owned_tokens (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  position_manager_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  owned INTEGER NOT NULL,
  last_event_block TEXT NOT NULL,
  last_event_log_index INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, wallet_address, position_manager_address, token_id)
);
CREATE INDEX uniswap_v4_owned_tokens_wallet_idx
  ON uniswap_v4_owned_tokens(integration_id, wallet_address, position_manager_address, owned);
`,
  },
  {
    name: '0004_multichain_rpc_and_rule_groups',
    sql: `
ALTER TABLE rules ADD COLUMN combinator TEXT NOT NULL DEFAULT 'and';
CREATE TABLE rule_conditions (
  id TEXT PRIMARY KEY NOT NULL,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  metric TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  operator TEXT NOT NULL,
  threshold TEXT NOT NULL,
  window_seconds INTEGER,
  hysteresis TEXT NOT NULL DEFAULT '0'
);
CREATE INDEX rule_conditions_rule_idx ON rule_conditions(rule_id, position);
CREATE INDEX rule_conditions_metric_idx ON rule_conditions(metric, rule_id);
INSERT INTO rule_conditions (
  id, rule_id, position, metric, labels_json, operator, threshold, window_seconds, hysteresis
)
SELECT id || '_condition_0', id, 0, metric, labels_json, operator, threshold, window_seconds, hysteresis
FROM rules;
CREATE TABLE integration_network_health (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  rpc_status TEXT NOT NULL,
  aave_v3_status TEXT NOT NULL DEFAULT 'unknown',
  uniswap_v3_status TEXT NOT NULL DEFAULT 'unknown',
  uniswap_v4_status TEXT NOT NULL DEFAULT 'unknown',
  block_number TEXT,
  error_code TEXT,
  tested_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, chain_id)
);
`,
  },
  {
    name: '0005_market_metrics_and_event_dedupe',
    sql: `
CREATE TABLE market_metric_samples (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (monitor_id, metric_name, observed_at)
);
CREATE INDEX market_metric_samples_observed_at_idx ON market_metric_samples(observed_at);
INSERT INTO market_metric_samples (monitor_id, metric_name, observed_at, value)
SELECT monitor_id, 'price', observed_at, price FROM price_samples;
CREATE TABLE processed_metric_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL
);
CREATE INDEX processed_metric_events_monitor_idx
  ON processed_metric_events(monitor_id, received_at);
`,
  },
  {
    name: '0006_aave_resources_events_and_samples',
    sql: `
ALTER TABLE processed_metric_events RENAME TO processed_metric_events_v1;
CREATE TABLE processed_metric_events (
  event_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  metric_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (monitor_id, event_id, metric_name)
);
INSERT INTO processed_metric_events (event_id, monitor_id, received_at, metric_name)
SELECT event_id, monitor_id, received_at, '' FROM processed_metric_events_v1;
DROP TABLE processed_metric_events_v1;
CREATE INDEX processed_metric_events_monitor_idx
  ON processed_metric_events(monitor_id, received_at);
CREATE TABLE chain_scan_cursors (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  last_scanned_block TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, protocol, chain_id, stream_key)
);
CREATE TABLE protocol_metric_samples (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (monitor_id, metric_name, observed_at)
);
ALTER TABLE integration_network_health ADD COLUMN aave_account_read_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE integration_network_health ADD COLUMN aave_reserve_catalog_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE integration_network_health ADD COLUMN aave_event_logs_status TEXT NOT NULL DEFAULT 'unknown';
`,
  },
  {
    name: '0007_uniswap_resource_catalog',
    sql: `
CREATE TABLE uniswap_pools (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  pool_address TEXT,
  pool_id TEXT,
  token0_address TEXT NOT NULL,
  token0_symbol TEXT,
  token0_decimals INTEGER,
  token0_native INTEGER NOT NULL DEFAULT 0,
  token1_address TEXT NOT NULL,
  token1_symbol TEXT,
  token1_decimals INTEGER,
  token1_native INTEGER NOT NULL DEFAULT 0,
  fee_tier INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks_address TEXT,
  discovered_at_block TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, chain_id, version, resource_id)
);
CREATE INDEX uniswap_pools_search_idx
  ON uniswap_pools(integration_id, chain_id, version, token0_symbol, token1_symbol);
CREATE TABLE token_metadata_cache (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  decimals INTEGER,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, address)
);
`,
  },
  {
    name: '0008_reliable_events_and_uniswap_windows',
    sql: `
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
`,
  },
] as const;

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const getApplied = sqlite.prepare('SELECT checksum FROM schema_migrations WHERE name = ?');
  const recordApplied = sqlite.prepare(
    'INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of migrations) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const applied = getApplied.get(migration.name) as { checksum: string } | undefined;
    if (applied !== undefined) {
      if (applied.checksum !== checksum) {
        throw new Error(`Applied migration ${migration.name} has an unexpected checksum`);
      }
      continue;
    }

    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      recordApplied.run(migration.name, checksum, new Date().toISOString());
    })();
  }
}
