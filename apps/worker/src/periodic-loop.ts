const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `task` every `intervalMs` until stopped. A failed run is reported and the loop carries on:
 * a processor outage must not take the worker down. `stop()` resolves once the run in progress ends.
 */
export class PeriodicLoop {
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.task();
      } catch (error) {
        this.onError(error);
      }
      // sleep in short slices so shutdown is prompt
      for (let waited = 0; waited < this.intervalMs && !this.stopping; waited += 200) {
        await sleep(Math.min(200, this.intervalMs - waited));
      }
    }
  }
}
