import { and, asc, eq } from 'drizzle-orm';

import type { AppDatabase } from '../client.js';
import { integrationNetworkHealth } from '../schema/index.js';

export type CapabilityStatus = 'ok' | 'error' | 'unknown';

export interface IntegrationNetworkHealthRecord {
  integrationId: string;
  chainId: number;
  rpcStatus: CapabilityStatus;
  aaveV3Status: CapabilityStatus;
  aaveAccountReadStatus: CapabilityStatus;
  aaveReserveCatalogStatus: CapabilityStatus;
  aaveEventLogsStatus: CapabilityStatus;
  uniswapV3Status: CapabilityStatus;
  uniswapV4Status: CapabilityStatus;
  blockNumber: string | null;
  errorCode: string | null;
  testedAt: string;
}

export class IntegrationNetworkHealthRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public list(): IntegrationNetworkHealthRecord[] {
    return this.database.select().from(integrationNetworkHealth)
      .orderBy(asc(integrationNetworkHealth.chainId), asc(integrationNetworkHealth.integrationId)).all() as IntegrationNetworkHealthRecord[];
  }

  public get(integrationId: string, chainId: number): IntegrationNetworkHealthRecord | undefined {
    return this.database.select().from(integrationNetworkHealth).where(and(
      eq(integrationNetworkHealth.integrationId, integrationId),
      eq(integrationNetworkHealth.chainId, chainId),
    )).get() as IntegrationNetworkHealthRecord | undefined;
  }

  public replace(record: IntegrationNetworkHealthRecord): void {
    this.database.insert(integrationNetworkHealth).values(record).onConflictDoUpdate({
      target: [integrationNetworkHealth.integrationId, integrationNetworkHealth.chainId],
      set: record,
    }).run();
  }

  public removeIntegration(integrationId: string): void {
    this.database.delete(integrationNetworkHealth)
      .where(eq(integrationNetworkHealth.integrationId, integrationId)).run();
  }
}
