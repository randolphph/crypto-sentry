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
CREATE INDEX processed_metric_events_monitor_idx ON processed_metric_events(monitor_id, received_at);

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
