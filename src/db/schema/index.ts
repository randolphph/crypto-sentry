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

export const schemaMigrations = sqliteTable('schema_migrations', {
  name: text('name').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: text('applied_at').notNull(),
});
