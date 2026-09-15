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
