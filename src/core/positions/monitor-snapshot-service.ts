import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { MetricSnapshotReader } from '../metrics/latest-metric-store.js';
import { AavePositionSnapshotService } from './aave-position-snapshot-service.js';
import { UniswapV3PositionSnapshotService } from './uniswap-v3-position-snapshot-service.js';
import { AavePoolSnapshotService } from './aave-pool-snapshot-service.js';

export class MonitorSnapshotService {
  private readonly aave: AavePositionSnapshotService;
  private readonly uniswap: UniswapV3PositionSnapshotService;
  private readonly aavePool: AavePoolSnapshotService;

  public constructor(
    private readonly monitors: MonitorRepository,
    private readonly metrics: MetricSnapshotReader,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.aave = new AavePositionSnapshotService(monitors, metrics, now);
    this.uniswap = new UniswapV3PositionSnapshotService(monitors, metrics, now);
    this.aavePool = new AavePoolSnapshotService(monitors, metrics, now);
  }

  public get(monitorId: string) {
    const monitor = this.monitors.get(monitorId);
    if (monitor.type === 'uniswap_pool') {
      return {
        monitorId, monitorType: monitor.type, status: 'unsupported' as const,
        observedAt: null, dataAgeSeconds: null, maxStaleSeconds: monitor.maxStaleSeconds,
        capability: { available: false, reason: 'MONITOR_TYPE_NOT_READY' },
        summary: {}, data: {},
        error: { code: 'MONITOR_TYPE_NOT_READY', message: `${monitor.type} is planned but not implemented` },
      };
    }
    if (monitor.type === 'aave_pool') {
      const snapshot = this.aavePool.get(monitorId);
      const { summary, error, observedAt, dataAgeSeconds, status, maxStaleSeconds, ...data } = snapshot;
      return {
        monitorId, monitorType: monitor.type, status, observedAt, dataAgeSeconds, maxStaleSeconds,
        capability: { available: true, reason: null }, summary, data, error,
      };
    }
    if (monitor.type === 'aave_account' || monitor.type === 'aave_position') {
      const snapshot = this.aave.get(monitorId);
      const { summary, error, observedAt, dataAgeSeconds, status, maxStaleSeconds, ...data } = snapshot;
      return {
        monitorId, monitorType: monitor.type, status, observedAt, dataAgeSeconds, maxStaleSeconds,
        capability: { available: true, reason: null }, summary, data, error,
      };
    }
    if (['uniswap_position', 'uniswap_wallet', 'lp_position'].includes(monitor.type)) {
      const snapshot = this.uniswap.get(monitorId);
      const { summary, error, observedAt, dataAgeSeconds, status, maxStaleSeconds, ...data } = snapshot;
      return {
        monitorId, monitorType: monitor.type, status, observedAt, dataAgeSeconds, maxStaleSeconds,
        capability: { available: true, reason: null }, summary, data, error,
      };
    }
    const metrics = this.metrics.list(monitorId);
    const observedAt = metrics.reduce<string | null>((latest, metric) => (
      latest === null || Date.parse(metric.observedAt) > Date.parse(latest) ? metric.observedAt : latest
    ), null);
    const dataAgeSeconds = observedAt === null ? null : Math.max(0, (this.now().getTime() - Date.parse(observedAt)) / 1_000);
    const status = metrics.length === 0 ? 'warming_up' : monitor.lastStatus;
    return {
      monitorId, monitorType: monitor.type, status, observedAt, dataAgeSeconds,
      maxStaleSeconds: monitor.maxStaleSeconds,
      capability: { available: true, reason: null },
      summary: { metricCount: metrics.length }, data: { metrics }, error: null,
    };
  }
}
