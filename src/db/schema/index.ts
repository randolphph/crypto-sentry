import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  configCiphertext: text('config_ciphertext').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const integrationMarkets = sqliteTable(
  'integration_markets',
  {
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    marketType: text('market_type').notNull(),
    providerSymbol: text('provider_symbol').notNull(),
    canonicalSymbol: text('canonical_symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset').notNull(),
    status: text('status').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.integrationId, table.marketType, table.providerSymbol] }),
    index('integration_markets_canonical_idx').on(table.integrationId, table.canonicalSymbol),
  ],
);

export const monitors = sqliteTable(
  'monitors',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    intervalSeconds: integer('interval_seconds').notNull().default(20),
    maxStaleSeconds: integer('max_stale_seconds').notNull().default(90),
    configJson: text('config_json').notNull(),
    lastStatus: text('last_status').notNull().default('warming_up'),
    lastDataAt: text('last_data_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('monitors_enabled_idx').on(table.enabled)],
);

export const rules = sqliteTable(
  'rules',
  {
    id: text('id').primaryKey(),
    monitorId: text('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    combinator: text('combinator').notNull().default('and'),
    metric: text('metric').notNull(),
    labelsJson: text('labels_json').notNull().default('{}'),
    operator: text('operator').notNull(),
    threshold: text('threshold').notNull(),
    windowSeconds: integer('window_seconds'),
    durationSeconds: integer('duration_seconds').notNull().default(0),
    cooldownSeconds: integer('cooldown_seconds').notNull().default(1800),
    hysteresis: text('hysteresis').notNull().default('0'),
    severity: text('severity').notNull(),
    notificationIntegrationIdsJson: text('notification_integration_ids_json').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('rules_monitor_id_idx').on(table.monitorId)],
);

export const ruleConditions = sqliteTable(
  'rule_conditions',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    metric: text('metric').notNull(),
    labelsJson: text('labels_json').notNull().default('{}'),
    operator: text('operator').notNull(),
    threshold: text('threshold').notNull(),
    windowSeconds: integer('window_seconds'),
    hysteresis: text('hysteresis').notNull().default('0'),
  },
  (table) => [
    index('rule_conditions_rule_idx').on(table.ruleId, table.position),
    index('rule_conditions_metric_idx').on(table.metric, table.ruleId),
  ],
);

export const integrationNetworkHealth = sqliteTable(
  'integration_network_health',
  {
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    chainId: integer('chain_id').notNull(),
    rpcStatus: text('rpc_status').notNull(),
    aaveV3Status: text('aave_v3_status').notNull().default('unknown'),
    aaveAccountReadStatus: text('aave_account_read_status').notNull().default('unknown'),
    aaveReserveCatalogStatus: text('aave_reserve_catalog_status').notNull().default('unknown'),
    aaveEventLogsStatus: text('aave_event_logs_status').notNull().default('unknown'),
    uniswapV3Status: text('uniswap_v3_status').notNull().default('unknown'),
    uniswapV4Status: text('uniswap_v4_status').notNull().default('unknown'),
    blockNumber: text('block_number'),
    errorCode: text('error_code'),
    testedAt: text('tested_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.integrationId, table.chainId] })],
);

export const ruleStates = sqliteTable('rule_states', {
  ruleId: text('rule_id')
    .primaryKey()
    .references(() => rules.id, { onDelete: 'cascade' }),
  state: text('state').notNull().default('ARMED'),
  conditionSince: text('condition_since'),
  lastValue: text('last_value'),
  lastAlertAt: text('last_alert_at'),
  updatedAt: text('updated_at').notNull(),
});

export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id').references(() => rules.id, { onDelete: 'set null' }),
    monitorId: text('monitor_id').references(() => monitors.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('open'),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    metricName: text('metric_name'),
    currentValue: text('current_value'),
    threshold: text('threshold'),
    observedAt: text('observed_at').notNull(),
    acknowledgedAt: text('acknowledged_at'),
    resolvedAt: text('resolved_at'),
    deliveryJson: text('delivery_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('alerts_status_created_at_idx').on(table.status, table.createdAt),
    index('alerts_rule_id_idx').on(table.ruleId),
  ],
);

export const priceSamples = sqliteTable(
  'price_samples',
  {
    monitorId: text('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    observedAt: text('observed_at').notNull(),
    price: text('price').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.observedAt] }),
    index('price_samples_observed_at_idx').on(table.observedAt),
  ],
);

export const marketMetricSamples = sqliteTable(
  'market_metric_samples',
  {
    monitorId: text('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    metricName: text('metric_name').notNull(),
    observedAt: text('observed_at').notNull(),
    value: text('value').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.metricName, table.observedAt] }),
    index('market_metric_samples_observed_at_idx').on(table.observedAt),
  ],
);

export const processedMetricEvents = sqliteTable(
  'processed_metric_events',
  {
    eventId: text('event_id').notNull(),
    monitorId: text('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    receivedAt: text('received_at').notNull(),
    metricName: text('metric_name').notNull().default(''),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.eventId, table.metricName] }),
    index('processed_metric_events_monitor_idx').on(table.monitorId, table.receivedAt),
  ],
);

export const chainScanCursors = sqliteTable(
  'chain_scan_cursors',
  {
    integrationId: text('integration_id').notNull().references(() => integrations.id, { onDelete: 'cascade' }),
    protocol: text('protocol').notNull(),
    chainId: integer('chain_id').notNull(),
    streamKey: text('stream_key').notNull(),
    lastScannedBlock: text('last_scanned_block').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.integrationId, table.protocol, table.chainId, table.streamKey] })],
);

export const protocolMetricSamples = sqliteTable(
  'protocol_metric_samples',
  {
    monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
    metricName: text('metric_name').notNull(),
    observedAt: text('observed_at').notNull(),
    value: text('value').notNull(),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.metricName, table.observedAt] })],
);

export const uniswapPools = sqliteTable(
  'uniswap_pools',
  {
    integrationId: text('integration_id').notNull().references(() => integrations.id, { onDelete: 'cascade' }),
    chainId: integer('chain_id').notNull(),
    version: text('version').notNull(),
    resourceId: text('resource_id').notNull(),
    poolAddress: text('pool_address'),
    poolId: text('pool_id'),
    token0Address: text('token0_address').notNull(),
    token0Symbol: text('token0_symbol'),
    token0Decimals: integer('token0_decimals'),
    token0Native: integer('token0_native', { mode: 'boolean' }).notNull().default(false),
    token1Address: text('token1_address').notNull(),
    token1Symbol: text('token1_symbol'),
    token1Decimals: integer('token1_decimals'),
    token1Native: integer('token1_native', { mode: 'boolean' }).notNull().default(false),
    feeTier: integer('fee_tier').notNull(),
    tickSpacing: integer('tick_spacing').notNull(),
    hooksAddress: text('hooks_address'),
    discoveredAtBlock: text('discovered_at_block').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.integrationId, table.chainId, table.version, table.resourceId] }),
    index('uniswap_pools_search_idx').on(table.integrationId, table.chainId, table.version, table.token0Symbol, table.token1Symbol),
  ],
);

export const tokenMetadataCache = sqliteTable(
  'token_metadata_cache',
  {
    chainId: integer('chain_id').notNull(),
    address: text('address').notNull(),
    symbol: text('symbol'),
    decimals: integer('decimals'),
    status: text('status').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.address] })],
);

export const uniswapV4ScanCheckpoints = sqliteTable(
  'uniswap_v4_scan_checkpoints',
  {
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address').notNull(),
    positionManagerAddress: text('position_manager_address').notNull(),
    lastScannedBlock: text('last_scanned_block').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.integrationId, table.walletAddress, table.positionManagerAddress] })],
);

export const uniswapV4OwnedTokens = sqliteTable(
  'uniswap_v4_owned_tokens',
  {
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address').notNull(),
    positionManagerAddress: text('position_manager_address').notNull(),
    tokenId: text('token_id').notNull(),
    owned: integer('owned', { mode: 'boolean' }).notNull(),
    lastEventBlock: text('last_event_block').notNull(),
    lastEventLogIndex: integer('last_event_log_index').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.integrationId, table.walletAddress, table.positionManagerAddress, table.tokenId] }),
    index('uniswap_v4_owned_tokens_wallet_idx').on(
      table.integrationId,
      table.walletAddress,
      table.positionManagerAddress,
      table.owned,
    ),
  ],
);

export const schemaMigrations = sqliteTable('schema_migrations', {
  name: text('name').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: text('applied_at').notNull(),
});
