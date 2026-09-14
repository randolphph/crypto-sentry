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
