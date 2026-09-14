import { asc, eq } from 'drizzle-orm';

import { integrationCreateSchema } from '../../api/schemas.js';
import type { IntegrationCreate, IntegrationPatch } from '../../api/schemas.js';
import { AppError } from '../../api/errors.js';
import { createId } from '../../core/ids.js';
import type { EncryptionService } from '../../security/encryption/encryption-service.js';
import { maskSensitiveConfig } from '../../security/encryption/encryption-service.js';
import type { AppDatabase } from '../client.js';
import { integrations, monitors, rules } from '../schema/index.js';

function mergeConfig(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === '********') continue;
    const oldValue = current[key];
    merged[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      oldValue !== null && typeof oldValue === 'object' && !Array.isArray(oldValue)
        ? mergeConfig(oldValue as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return merged;
}

export class IntegrationRepository {
  public constructor(
    private readonly database: AppDatabase['db'],
    private readonly encryption: EncryptionService,
  ) {}

  public list() {
    return this.database.select().from(integrations).orderBy(asc(integrations.createdAt)).all().map((row) => this.present(row));
  }

  public listRuntime() {
    return this.database.select().from(integrations).orderBy(asc(integrations.createdAt)).all().map((row) => {
      const { configCiphertext: _, ...runtimeRow } = row;
      return {
        ...runtimeRow,
        config: this.encryption.decryptJson<Record<string, unknown>>(row.configCiphertext),
      };
    });
  }

  public get(id: string) {
    const row = this.database.select().from(integrations).where(eq(integrations.id, id)).get();
    if (row === undefined) throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Integration was not found');
    return this.present(row);
  }

  public getRuntimeConfig(id: string): Record<string, unknown> {
    return this.getRuntime(id).config;
  }

  public getRuntime(id: string) {
    const row = this.database.select().from(integrations).where(eq(integrations.id, id)).get();
    if (row === undefined) throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Integration was not found');
    const { configCiphertext: _, ...runtimeRow } = row;
    return {
      ...runtimeRow,
      config: this.encryption.decryptJson<Record<string, unknown>>(row.configCiphertext),
    };
  }

  public create(input: IntegrationCreate) {
    const timestamp = new Date().toISOString();
    const row = {
      id: createId('int'),
      name: input.name,
      type: input.type,
      provider: input.provider,
      enabled: input.enabled,
      configCiphertext: this.encryption.encryptJson(input.config),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database.insert(integrations).values(row).run();
    return this.present(row);
  }

  public update(id: string, input: IntegrationPatch) {
    const row = this.database.select().from(integrations).where(eq(integrations.id, id)).get();
    if (row === undefined) throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Integration was not found');
    const currentConfig = this.encryption.decryptJson<Record<string, unknown>>(row.configCiphertext);
    const nextConfig = input.config === undefined ? currentConfig : mergeConfig(currentConfig, input.config);
    integrationCreateSchema.parse({
      name: input.name ?? row.name,
      type: row.type,
      provider: row.provider,
      enabled: input.enabled ?? row.enabled,
      config: nextConfig,
    });
    const updated = {
      ...row,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.config === undefined ? {} : { configCiphertext: this.encryption.encryptJson(nextConfig) }),
      updatedAt: new Date().toISOString(),
    };
    this.database.update(integrations).set(updated).where(eq(integrations.id, id)).run();
    return this.present(updated);
  }

  public delete(id: string): void {
    const monitorUsesIntegration = this.database.select({ configJson: monitors.configJson }).from(monitors).all().some((row) => {
      const config = JSON.parse(row.configJson) as Record<string, unknown>;
      return config.integrationId === id || config.rpcIntegrationId === id;
    });
    const ruleUsesIntegration = this.database.select({ ids: rules.notificationIntegrationIdsJson }).from(rules).all().some((row) => {
      return (JSON.parse(row.ids) as string[]).includes(id);
    });
    if (monitorUsesIntegration || ruleUsesIntegration) {
      throw new AppError(409, 'INTEGRATION_IN_USE', 'Delete or update dependent monitors and rules first');
    }
    const result = this.database.delete(integrations).where(eq(integrations.id, id)).run();
    if (result.changes === 0) throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Integration was not found');
  }

  private present(row: typeof integrations.$inferSelect) {
    const config = this.encryption.decryptJson<Record<string, unknown>>(row.configCiphertext);
    const { configCiphertext: _, ...publicRow } = row;
    return { ...publicRow, config: maskSensitiveConfig(config) };
  }
}
