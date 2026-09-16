import { BinanceMarketStreamManager } from '../../adapters/markets/binance/binance-market-stream-manager.js';
import type { MarketWebSocketFactory } from '../../adapters/markets/websocket/websocket-port.js';
import { binanceIntegrationConfigSchema } from '../../api/schemas.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { MarketMetricRuntime, MarketMetricService } from '../metrics/market-metric-service.js';

interface ActiveManager {
  fingerprint: string;
  manager: BinanceMarketStreamManager;
}

type RuntimeSubscription = ReturnType<MonitorRepository['listEnabledMarketSubscriptions']>[number];

interface ManagerPlan {
  integrationId: string;
  fingerprint: string;
  spotWebsocketUrl: string;
  futuresWebsocketUrl: string;
  subscriptions: RuntimeSubscription[];
}

export class BinanceMarketDataCoordinator {
  private readonly managers = new Map<string, ActiveManager>();

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly monitors: MonitorRepository,
    private readonly marketMetrics: MarketMetricService,
    private readonly webSocketFactory: MarketWebSocketFactory,
    private readonly onError: (error: Error) => void,
  ) {}

  public reconcile(): void {
    const subscriptionsByIntegration = new Map<string, RuntimeSubscription[]>();
    for (const subscription of this.monitors.listEnabledMarketSubscriptions()) {
      const subscriptions = subscriptionsByIntegration.get(subscription.integrationId) ?? [];
      subscriptions.push(subscription);
      subscriptionsByIntegration.set(subscription.integrationId, subscriptions);
    }

    const plans: ManagerPlan[] = [];
    const metricRuntimes: MarketMetricRuntime[] = [];
    for (const integration of this.integrations.listRuntime()) {
      if (!integration.enabled || integration.type !== 'market_data' || integration.provider !== 'binance') continue;
      const subscriptions = subscriptionsByIntegration.get(integration.id) ?? [];
      if (subscriptions.length === 0) continue;
      const parsedConfig = binanceIntegrationConfigSchema.safeParse(integration.config);
      if (!parsedConfig.success) {
        this.onError(new Error(`Binance integration ${integration.id} has invalid runtime configuration`));
        continue;
      }
      const fingerprint = `${parsedConfig.data.spotWebsocketUrl}\n${parsedConfig.data.futuresWebsocketUrl}`;
      plans.push({
        integrationId: integration.id,
        fingerprint,
        spotWebsocketUrl: parsedConfig.data.spotWebsocketUrl,
        futuresWebsocketUrl: parsedConfig.data.futuresWebsocketUrl,
        subscriptions,
      });
      metricRuntimes.push(...subscriptions.map((subscription) => ({
        ...subscription,
        integrationId: integration.id,
        intervalSeconds: subscription.intervalSeconds,
        maxStaleSeconds: subscription.maxStaleSeconds,
        priceWindowSeconds: subscription.priceWindowSeconds,
        openInterestWindowSeconds: subscription.openInterestWindowSeconds,
        spotRestUrl: parsedConfig.data.restUrl,
        futuresRestUrl: parsedConfig.data.futuresRestUrl,
      })));
    }

    this.marketMetrics.reconcile(metricRuntimes);
    const activeIntegrationIds = new Set(plans.map((plan) => plan.integrationId));
    for (const plan of plans) {
      const { integrationId, fingerprint, spotWebsocketUrl, futuresWebsocketUrl, subscriptions } = plan;
      let active = this.managers.get(integrationId);
      if (active === undefined || active.fingerprint !== fingerprint) {
        active?.manager.close();
        const manager = new BinanceMarketStreamManager({
          spotWebsocketUrl,
          futuresWebsocketUrl,
          webSocketFactory: this.webSocketFactory,
          emitMetric: async (metric) => {
            await this.marketMetrics.ingestMetric(metric);
          },
          onError: this.onError,
        });
        active = { fingerprint, manager };
        this.managers.set(integrationId, active);
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
