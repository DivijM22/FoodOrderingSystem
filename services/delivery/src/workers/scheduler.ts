import type { Logger } from '@food/common';
import type { DeliveryService } from '../services/delivery.service.js';

/**
 * Drives time-based steps from deadlines persisted on the deliveries (prepareReadyAt, nextAssignAt),
 * never from in-memory timers: after a restart the next tick simply picks up whatever is due.
 * Safe with several instances: every step is a compare-and-set inside a transaction.
 */
export class DeliveryScheduler {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly delivery: DeliveryService,
    private readonly logger: Logger,
    private readonly intervalMs: number,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop() {
    clearInterval(this.timer);
    await this.running;
  }

  tick(): Promise<void> {
    this.running ??= (async () => {
      try {
        await this.delivery.promoteReady();
        await this.delivery.assignDue();
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'Delivery scheduler pass failed; will retry');
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
