/**
 * Owns when the globe renders. Cesium runs in `requestRenderMode` and draws
 * a frame only when something changed; this governor also stops the
 * requestAnimationFrame loop itself once frames stop coming, so an idle
 * globe costs no frames and no per-frame JavaScript.
 *
 * Rules:
 * - Ticks run only after `wake()` (data, camera input, resize, a render
 *   request from Cesium) and stop after `idleTicksBeforeSleep` ticks that
 *   drew nothing. `wakeForFrame()` (a periodic update that needs one frame,
 *   such as the satellites moving) sleeps right after the tick that draws,
 *   unless something else woke the loop meanwhile.
 * - At most `maxFps` ticks per second, `batteryFps` on battery.
 * - No ticks while the window is hidden or minimized. Showing the window
 *   again wakes the loop, so a camera flight or a wake that arrived while
 *   hidden continues.
 */

export interface GovernorRules {
  maxFps: number;
  batteryFps: number;
  idleTicksBeforeSleep: number;
  /** How often the day/night terminator moves while the globe is idle. */
  sunRefreshMs: number;
}

export const GOVERNOR_RULES: GovernorRules = {
  maxFps: 60,
  batteryFps: 30,
  idleTicksBeforeSleep: 20,
  sunRefreshMs: 10 * 60 * 1000
};

/** Runs one Cesium tick; returns true when it drew a frame. */
export type TickFn = () => boolean;

export interface FrameScheduler {
  request(callback: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

export interface GovernorStats {
  /** rAF callbacks that ran a Cesium tick. */
  ticks: number;
  /** Ticks that drew a frame. */
  frames: number;
  /** Times the loop went to sleep. */
  sleeps: number;
}

/** Tolerance for rAF timestamps that arrive a little early. */
const FRAME_SLACK_MS = 1;

export class RenderGovernor {
  private handle: number | null = null;
  private lastTickMs: number | null = null;
  private idleTicks = 0;
  /** The loop runs for one frame only (wakeForFrame), not to settle. */
  private singleFrame = false;
  private visible = true;
  private onBattery = false;
  private disposed = false;
  readonly stats: GovernorStats = { ticks: 0, frames: 0, sleeps: 0 };

  constructor(
    private readonly tick: TickFn,
    private readonly scheduler: FrameScheduler,
    private readonly rules: GovernorRules = GOVERNOR_RULES
  ) {}

  get running(): boolean {
    return this.handle !== null;
  }

  get frameIntervalMs(): number {
    return 1000 / (this.onBattery ? this.rules.batteryFps : this.rules.maxFps);
  }

  /** Asks for ticks until the scene settles. */
  wake(): void {
    if (this.disposed || !this.visible) {
      return;
    }
    this.idleTicks = 0;
    this.singleFrame = false;
    if (this.handle === null) {
      this.handle = this.scheduler.request(this.onFrame);
    }
  }

  /**
   * Asks for the next frame only. While the loop runs for another reason,
   * this changes nothing; a `wake()` before the frame makes the loop settle
   * as usual.
   */
  wakeForFrame(): void {
    if (this.disposed || !this.visible || this.handle !== null) {
      return;
    }
    this.idleTicks = 0;
    this.singleFrame = true;
    this.handle = this.scheduler.request(this.onFrame);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    if (visible) {
      this.wake();
    } else {
      this.stop();
    }
  }

  setOnBattery(onBattery: boolean): void {
    this.onBattery = onBattery;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  private stop(): void {
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
  }

  private readonly onFrame = (timeMs: number): void => {
    this.handle = null;
    if (this.disposed || !this.visible) {
      return;
    }
    if (
      this.lastTickMs !== null &&
      timeMs - this.lastTickMs + FRAME_SLACK_MS < this.frameIntervalMs
    ) {
      this.handle = this.scheduler.request(this.onFrame);
      return;
    }
    this.lastTickMs = timeMs;
    this.stats.ticks += 1;
    const singleFrame = this.singleFrame;
    if (this.tick()) {
      this.stats.frames += 1;
      // tick() may have called wake() (a render request during the frame).
      this.idleTicks = singleFrame && this.singleFrame ? this.rules.idleTicksBeforeSleep : 0;
    } else {
      this.idleTicks += 1;
    }
    if (this.idleTicks >= this.rules.idleTicksBeforeSleep) {
      this.singleFrame = false;
      this.stats.sleeps += 1;
      return;
    }
    // tick() may have woken the loop again (a render request during the frame).
    if (this.handle === null && !this.disposed) {
      this.handle = this.scheduler.request(this.onFrame);
    }
  };
}

export interface RenderQuality {
  /** Multiplies the device pixel ratio. */
  resolutionScale: number;
  msaaSamples: number;
}

/**
 * Sharp but bounded: render at the screen's pixel density up to 2x, and use
 * MSAA only on low-density screens, where lines would look jagged.
 */
export function renderQuality(devicePixelRatio: number): RenderQuality {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    resolutionScale: ratio > 2 ? 2 / ratio : 1,
    msaaSamples: ratio >= 1.5 ? 1 : 4
  };
}
