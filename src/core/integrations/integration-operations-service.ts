import { BinanceRestClient, BinanceRestError } from '../../adapters/markets/binance/binance-rest-client.js';
import { AppError } from '../../api/errors.js';
import { binanceIntegrationConfigSchema } from '../../api/schemas.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MarketRepository } from '../../db/repositories/market-repository.js';

export class IntegrationOperationsService {
  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly markets: MarketRepository,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  public async test(id: string) {
    const client = this.binanceClient(id);
    try {
      const connectivity = await client.testConnectivity();
      return { ok: true, provider: 'binance', connectivity };
    } catch (error) {
      this.throwConnectionError(error);
    }
  }

  public async syncMarkets(id: string) {
    const client = this.binanceClient(id);
    try {
      const discovered = await client.discoverMarkets();
      this.markets.replace(id, discovered);
      const spot = discovered.filter((market) => market.marketType === 'spot').length;
      const perpetual = discovered.length - spot;
      return { synchronizedAt: new Date().toISOString(), total: discovered.length, spot, perpetual };
    } catch (error) {
      this.throwConnectionError(error);
    }
  }

  public listMarkets(id: string) {
    this.requireBinance(id);
    return { items: this.markets.list(id) };
  }

  private binanceClient(id: string): BinanceRestClient {
    const integration = this.requireBinance(id);
    if (!integration.enabled) {
      throw new AppError(409, 'INTEGRATION_DISABLED', 'Enable the integration before using it');
    }
    const config = binanceIntegrationConfigSchema.parse(integration.config);
    return new BinanceRestClient({
      spotRestUrl: config.restUrl,
      futuresRestUrl: config.futuresRestUrl,
      fetch: this.fetchImplementation,
    });
  }

  private requireBinance(id: string) {
    const integration = this.integrations.getRuntime(id);
    if (integration.type !== 'market_data' || integration.provider !== 'binance') {
      throw new AppError(409, 'ADAPTER_NOT_READY', 'This integration adapter is not available in the current development stage');
    }
    return integration;
  }

  private throwConnectionError(error: unknown): never {
    if (error instanceof BinanceRestError) {
      throw new AppError(502, 'INTEGRATION_CONNECTION_FAILED', error.message);
    }
    throw error;
  }
}
