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
CREATE INDEX uniswap_pools_search_idx ON uniswap_pools(integration_id, chain_id, version, token0_symbol, token1_symbol);
CREATE TABLE token_metadata_cache (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  decimals INTEGER,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, address)
);
