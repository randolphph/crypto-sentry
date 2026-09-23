import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { AlertRepository, ClaimedAlertDelivery } from '../../db/repositories/alert-repository.js';
import { sendTelegramMessage } from '../../adapters/notifications/telegram-client.js';
import { formatTelegramAlert } from './telegram-alert-message.js';

const POLL_MILLISECONDS = 5_000;
const MAX_ATTEMPTS = 5;

export class AlertDeliveryService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;

  public constructor(
    private readonly alerts: AlertRepository,
    private readonly integrations: IntegrationRepository,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {}

  public start(): void {
    this.schedule(0);
  }

  public wake(): void {
    if (this.closed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.schedule(0);
  }

  public async processDue(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const work = this.drain();
    this.running = work;
    try {
      await work;
    } finally {
      if (this.running === work) this.running = undefined;
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.processDue().catch((error: unknown) => {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => this.schedule(POLL_MILLISECONDS));
    }, delay);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    // Yield between batches so a large backlog does not monopolize the event loop.
    for (let count = 0; count < 100 && !this.closed; count += 1) {
      const job = this.alerts.claimNextDelivery(new Date());
      if (job === undefined) return;
      await this.deliver(job);
    }
  }

  private async deliver(job: ClaimedAlertDelivery): Promise<void> {
    if (job.attempts > MAX_ATTEMPTS) {
      this.alerts.completeDelivery(job, { status: 'failed', errorCode: 'DELIVERY_ATTEMPTS_EXHAUSTED' });
      return;
    }
    if (job.alertStatus === 'resolved') {
      this.alerts.completeDelivery(job, { status: 'skipped', errorCode: 'ALERT_RESOLVED' });
      return;
    }
    let integration: ReturnType<IntegrationRepository['getRuntime']>;
    try {
      integration = this.integrations.getRuntime(job.integrationId);
    } catch {
      this.alerts.completeDelivery(job, { status: 'skipped', errorCode: 'INTEGRATION_MISSING' });
      return;
    }
    if (!integration.enabled || integration.type !== 'notification' || integration.provider !== 'telegram') {
      this.alerts.completeDelivery(job, { status: 'skipped', errorCode: 'INTEGRATION_UNAVAILABLE' });
      return;
    }
    const config = integration.config;
    if (typeof config.botToken !== 'string' || typeof config.chatId !== 'string') {
      this.alerts.completeDelivery(job, { status: 'skipped', errorCode: 'INTEGRATION_INVALID' });
      return;
    }
    const result = await sendTelegramMessage(
      { botToken: config.botToken, chatId: config.chatId },
      formatTelegramAlert(job),
      this.fetchImplementation,
    );
    if (result.ok) {
      this.alerts.completeDelivery(job, { status: 'sent' });
      return;
    }
    if (!result.retryable || job.attempts >= MAX_ATTEMPTS) {
      this.alerts.completeDelivery(job, { status: 'failed', errorCode: result.code });
      return;
    }
    const delaySeconds = Math.max(result.retryAfterSeconds ?? 0, Math.min(300, 5 * 2 ** (job.attempts - 1)));
    this.alerts.completeDelivery(job, {
      status: 'pending', errorCode: result.code,
      nextAttemptAt: new Date(Date.now() + delaySeconds * 1_000).toISOString(),
    });
  }
}
