/**
 * Moves the satellites at a bounded rate. The render governor lets an idle
 * globe draw no frames; moving satellites need some, so while the layer has
 * satellites this asks for at most one update (and so one frame) per
 * `intervalMs`, and none while the window is hidden or minimized. With the
 * layer off it runs nothing at all.
 */

/** One position update per second: a satellite in low orbit moves about 7.6 km. */
export const SATELLITE_UPDATE_MS = 1000;

export interface TickerTimers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  now(): number;
}

const BROWSER_TIMERS: TickerTimers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
  now: () => performance.now()
};

export class PeriodicTicker {
  private handle: number | null = null;
  private lastTick = Number.NEGATIVE_INFINITY;
  private running = false;
  private visible = true;
  private disposed = false;
  /** Ticks run so far (for tests and checks). */
  ticks = 0;

  constructor(
    private readonly tick: () => void,
    private readonly intervalMs: number = SATELLITE_UPDATE_MS,
    private readonly timers: TickerTimers = BROWSER_TIMERS
  ) {}

  private get active(): boolean {
    return this.running && this.visible && !this.disposed;
  }

  /** Something to move (the layer has satellites). */
  setRunning(running: boolean): void {
    this.running = running;
    this.sync();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.sync();
  }

  /**
   * Updates now, for new data, if the ticker is active; the next update
   * then follows one interval later.
   */
  poke(): void {
    if (this.active) {
      this.clear();
      this.fire();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  private sync(): void {
    if (!this.active) {
      this.clear();
      return;
    }
    if (this.handle === null) {
      // Back from hidden: update at once if the last update is old enough.
      const wait = Math.max(0, this.lastTick + this.intervalMs - this.timers.now());
      this.handle = this.timers.setTimeout(this.fire, wait);
    }
  }

  private readonly fire = (): void => {
    this.handle = null;
    if (!this.active) {
      return;
    }
    this.lastTick = this.timers.now();
    this.ticks += 1;
    this.tick();
    if (this.active && this.handle === null) {
      this.handle = this.timers.setTimeout(this.fire, this.intervalMs);
    }
  };
}
