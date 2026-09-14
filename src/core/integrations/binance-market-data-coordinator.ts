import { BinanceMarketStreamManager } from '../../adapters/markets/binance/binance-market-stream-manager.js';
import type { BinanceMonitorSubscription } from '../../adapters/markets/binance/binance-market-stream-manager.js';
import type { MarketWebSocketFactory } from '../../adapters/markets/websocket/websocket-port.js';
import { binanceIntegrationConfigSchema } from '../../api/schemas.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { MetricPipeline } from '../metrics/metric-pipeline.js';

interface ActiveManager {
  fingerprint: string;
  manager: BinanceMarketStreamManager;
}

export class BinanceMarketDataCoordinator {
  private readonly managers = new Map<string, ActiveManager>();

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly monitors: MonitorRepository,
    private readonly metricPipeline: MetricPipeline,
    private readonly webSocketFactory: MarketWebSocketFactory,
    private readonly onError: (error: Error) => void,
  ) {}

  public reconcile(): void {
    const subscriptionsByIntegration = new Map<string, BinanceMonitorSubscription[]>();
    for (const subscription of this.monitors.listEnabledMarketSubscriptions()) {
      const subscriptions = subscriptionsByIntegration.get(subscription.integrationId) ?? [];
      subscriptions.push(subscription);
      subscriptionsByIntegration.set(subscription.integrationId, subscriptions);
    }

    const activeIntegrationIds = new Set<string>();
    for (const integration of this.integrations.listRuntime()) {
      if (!integration.enabled || integration.type !== 'market_data' || integration.provider !== 'binance') continue;
      const subscriptions = subscriptionsByIntegration.get(integration.id) ?? [];
      if (subscriptions.length === 0) continue;
      const parsedConfig = binanceIntegrationConfigSchema.safeParse(integration.config);
      if (!parsedConfig.success) {
        this.onError(new Error(`Binance integration ${integration.id} has invalid runtime configuration`));
        continue;
      }
      activeIntegrationIds.add(integration.id);
      const fingerprint = `${parsedConfig.data.spotWebsocketUrl}\n${parsedConfig.data.futuresWebsocketUrl}`;
      let active = this.managers.get(integration.id);
      if (active === undefined || active.fingerprint !== fingerprint) {
        active?.manager.close();
        const manager = new BinanceMarketStreamManager({
          spotWebsocketUrl: parsedConfig.data.spotWebsocketUrl,
          futuresWebsocketUrl: parsedConfig.data.futuresWebsocketUrl,
          webSocketFactory: this.webSocketFactory,
          emitMetric: async (metric) => {
            await this.metricPipeline.ingest(metric);
          },
          onError: this.onError,
        });
        active = { fingerprint, manager };
        this.managers.set(integration.id, active);
      }
      active.manager.setSubscriptions(subscriptions);
    }

    for (const [integrationId, active] of this.managers) {
      if (activeIntegrationIds.has(integrationId)) continue;
      active.manager.close();
      this.managers.delete(integrationId);
    }
  }

  public close(): void {
    for (const active of this.managers.values()) active.manager.close();
    this.managers.clear();
  }
}
