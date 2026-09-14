import { AppError } from '../../api/errors.js';
import type { AaveRiskRulePreset } from '../../api/schemas.js';
import type { RuleRepository } from '../../db/repositories/rule-repository.js';
import type { AavePositionSnapshotService } from '../positions/aave-position-snapshot-service.js';

interface PresetRuleResult {
  id: string;
  name: string;
  chainId: number;
  severity: 'warning' | 'critical';
  threshold: string;
  created: boolean;
}

export interface AaveRiskRulePresetResult {
  createdCount: number;
  existingCount: number;
  items: PresetRuleResult[];
}

export class AaveRiskRulePresetService {
  public constructor(
    private readonly positions: AavePositionSnapshotService,
    private readonly rules: RuleRepository,
  ) {}

  public create(monitorId: string, preset: AaveRiskRulePreset): AaveRiskRulePresetResult {
    const snapshot = this.positions.get(monitorId);
    if (snapshot.networkScans.length === 0) {
      throw new AppError(
        409,
        'AAVE_SCAN_NOT_READY',
        'Aave risk rules require at least one discovered supported network',
      );
    }

    const existingRules = this.rules.list();
    const items: PresetRuleResult[] = [];
    for (const network of snapshot.networkScans) {
      const definitions = [
        {
          severity: 'warning' as const,
          threshold: preset.warningThreshold,
          durationSeconds: preset.warningDurationSeconds,
          hysteresis: '0.05',
        },
        {
          severity: 'critical' as const,
          threshold: preset.criticalThreshold,
          durationSeconds: preset.criticalDurationSeconds,
          hysteresis: '0.02',
        },
      ];
      for (const definition of definitions) {
        const name = `[Aave V3] ${network.chainName} health factor ${definition.severity}`;
        const existing = existingRules.find((rule) => rule.monitorId === monitorId && rule.name === name);
        if (existing !== undefined) {
          items.push({
            id: existing.id,
            name: existing.name,
            chainId: network.chainId,
            severity: definition.severity,
            threshold: existing.threshold,
            created: false,
          });
          continue;
        }
        const created = this.rules.create({
          monitorId,
          name,
          metric: 'health_factor',
          labels: { chainId: String(network.chainId) },
          operator: 'lte',
          threshold: definition.threshold,
          durationSeconds: definition.durationSeconds,
          cooldownSeconds: preset.cooldownSeconds,
          hysteresis: definition.hysteresis,
          severity: definition.severity,
          notificationIntegrationIds: preset.notificationIntegrationIds,
          enabled: true,
        });
        items.push({
          id: created.id,
          name: created.name,
          chainId: network.chainId,
          severity: definition.severity,
          threshold: created.threshold,
          created: true,
        });
      }
    }
    const createdCount = items.filter(({ created }) => created).length;
    return { createdCount, existingCount: items.length - createdCount, items };
  }
}
