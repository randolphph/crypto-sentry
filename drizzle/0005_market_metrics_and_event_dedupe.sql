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
