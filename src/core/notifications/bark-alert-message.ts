import type { ClaimedAlertDelivery } from '../../db/repositories/alert-repository.js';
import type { BarkNotificationLevel } from '../../adapters/notifications/bark-client.js';
import { formatTelegramAlert } from './telegram-alert-message.js';

export function formatBarkAlert(job: ClaimedAlertDelivery) {
  const [title = 'CryptoSentry 告警', ...lines] = formatTelegramAlert(job).split('\n');
  const level: BarkNotificationLevel = job.severity === 'emergency' ? 'critical'
    : job.severity === 'critical' ? 'timeSensitive' : 'active';
  return { title, body: lines.join('\n'), level };
}
