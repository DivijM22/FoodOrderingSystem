import type { Logger } from '@food/common';
import type { PaymentWorkflow } from './workflow.js';

/**
 * Drives provider-side work that must survive crashes and transient failures:
 * cancelling PaymentIntents of cancelled orders, submitting refunds, and polling Stripe when a
 * webhook is late or lost. Runs on an interval and immediately when kicked; overlapping runs collapse.
 */
export class Reconciler {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly workflow: PaymentWorkflow,
    private readonly logger: Logger,
    private readonly intervalMs = 5000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  kick(): void {
    void this.run();
  }

  run(): Promise<void> {
    if (this.running) {
      this.again = true; // something changed mid-run: do one more pass afterwards
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.workflow.reconcile();
        } catch (err) {
          this.logger.error({ err }, 'Reconciliation pass failed');
        }
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
