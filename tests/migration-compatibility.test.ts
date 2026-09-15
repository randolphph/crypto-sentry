import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migrations, runMigrations } from '../src/db/migrations.js';

describe('0004_multichain_rpc_and_rule_groups migration', () => {
  it('upgrades an existing database and preserves/backfills legacy rules atomically', () => {
    const sqlite = new BetterSqlite3(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const record = sqlite.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)');
    for (const migration of migrations.slice(0, 4)) {
      sqlite.exec(migration.sql);
      record.run(migration.name, createHash('sha256').update(migration.sql).digest('hex'), '2026-09-15T00:00:00.000Z');
    }
    sqlite.prepare(`INSERT INTO monitors (
      id,name,type,enabled,interval_seconds,max_stale_seconds,config_json,last_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'mon_existing', 'Existing', 'market', 1, 20, 90, '{}', 'ok',
      '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z',
    );
    sqlite.prepare(`INSERT INTO rules (
      id,monitor_id,name,metric,labels_json,operator,threshold,window_seconds,duration_seconds,
      cooldown_seconds,hysteresis,severity,notification_integration_ids_json,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'rule_existing', 'mon_existing', 'Existing rule', 'price_change_percent', '{"windowSeconds":"300"}',
      'gte', '3.000000000000000001', 300, 60, 1800, '0.2', 'warning', '[]', 1,
      '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z',
    );
    sqlite.prepare(`INSERT INTO rule_states (
      rule_id,state,condition_since,last_value,last_alert_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(
      'rule_existing', 'TRIGGERED', '2026-09-15T00:00:00.000Z', '3.1',
      '2026-09-15T00:01:00.000Z', '2026-09-15T00:01:00.000Z',
    );

    runMigrations(sqlite);

    expect(sqlite.prepare('SELECT id, combinator FROM rules WHERE id = ?').get('rule_existing')).toEqual({
      id: 'rule_existing', combinator: 'and',
    });
    expect(sqlite.prepare(`SELECT metric, labels_json AS labelsJson, operator, threshold,
      window_seconds AS windowSeconds, hysteresis FROM rule_conditions WHERE rule_id = ?`).get('rule_existing')).toEqual({
      metric: 'price_change_percent', labelsJson: '{"windowSeconds":"300"}', operator: 'gte',
      threshold: '3.000000000000000001', windowSeconds: 300, hysteresis: '0.2',
    });
    expect(sqlite.prepare('SELECT state, last_value AS lastValue FROM rule_states WHERE rule_id = ?').get('rule_existing')).toEqual({
      state: 'TRIGGERED', lastValue: '3.1',
    });
    sqlite.close();
  });
});
