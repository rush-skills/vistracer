import { describe, expect, it } from "vitest";
import {
  GOVERNOR_RULES,
  RenderGovernor,
  renderQuality,
  type FrameScheduler
} from "@renderer/lib/renderGovernor";

/** A display that refreshes every `refreshMs`, driven by `advance`. */
class FakeDisplay implements FrameScheduler {
  now = 0;
  requests = 0;
  private next = 1;
  private pending = new Map<number, (timeMs: number) => void>();

  constructor(private readonly refreshMs = 1000 / 60) {}

  request(callback: (timeMs: number) => void): number {
    this.requests += 1;
    const handle = this.next++;
    this.pending.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.pending.delete(handle);
  }

  get scheduled(): number {
    return this.pending.size;
  }

  /** Runs the refreshes in the next `ms` milliseconds. */
  advance(ms: number): void {
    const end = this.now + ms;
    while (this.now + this.refreshMs <= end + 1e-9) {
      this.now += this.refreshMs;
      const callbacks = [...this.pending.values()];
      this.pending.clear();
      callbacks.forEach((callback) => callback(this.now));
    }
    this.now = end;
  }
}

/** A Cesium stand-in that draws while `dirtyFrames` remain. */
const fakeScene = () => {
  const scene = { dirtyFrames: 0, ticks: 0, drawn: 0 };
  const tick = () => {
    scene.ticks += 1;
    if (scene.dirtyFrames > 0) {
      scene.dirtyFrames -= 1;
      scene.drawn += 1;
      return true;
    }
    return false;
  };
  return { scene, tick };
};

describe("RenderGovernor", () => {
  it("runs no frames until something wakes it", () => {
    const display = new FakeDisplay();
    const { scene, tick } = fakeScene();
    const governor = new RenderGovernor(tick, display);
    display.advance(10_000);
    expect(display.requests).toBe(0);
    expect(scene.ticks).toBe(0);
    expect(governor.running).toBe(false);
  });

  it("draws while the scene changes, then sleeps and stays idle", () => {
    const display = new FakeDisplay();
    const { scene, tick } = fakeScene();
    const governor = new RenderGovernor(tick, display);

    scene.dirtyFrames = 30; // a camera flight
    governor.wake();
    display.advance(2_000);
    expect(scene.drawn).toBe(30);
    expect(governor.running).toBe(false);
    expect(governor.stats).toEqual({
      ticks: 30 + GOVERNOR_RULES.idleTicksBeforeSleep,
      frames: 30,
      sleeps: 1
    });

    // Idle: a minute passes with no animation frame requested at all.
    const requestsBefore = display.requests;
    display.advance(60_000);
    expect(display.requests).toBe(requestsBefore);
    expect(scene.ticks).toBe(30 + GOVERNOR_RULES.idleTicksBeforeSleep);
  });

  it("keeps running while a render request arrives during each frame", () => {
    const display = new FakeDisplay();
    let loading = 10; // tiles still loading: each tick asks for another frame
    const governor: RenderGovernor = new RenderGovernor(() => {
      if (loading > 0) {
        loading -= 1;
        governor.wake();
      }
      return false;
    }, display);
    governor.wake();
    display.advance(5_000);
    expect(governor.stats.ticks).toBe(10 + GOVERNOR_RULES.idleTicksBeforeSleep - 1);
    expect(governor.running).toBe(false);
  });

  it("caps the frame rate on fast displays and lowers it on battery", () => {
    const display = new FakeDisplay(1000 / 120);
    const { scene, tick } = fakeScene();
    const governor = new RenderGovernor(tick, display);

    scene.dirtyFrames = Number.POSITIVE_INFINITY;
    governor.wake();
    display.advance(1_000);
    expect(scene.ticks).toBeGreaterThanOrEqual(59);
    expect(scene.ticks).toBeLessThanOrEqual(GOVERNOR_RULES.maxFps);

    governor.setOnBattery(true);
    const before = scene.ticks;
    display.advance(1_000);
    expect(scene.ticks - before).toBeGreaterThanOrEqual(29);
    expect(scene.ticks - before).toBeLessThanOrEqual(GOVERNOR_RULES.batteryFps);
  });

  it("pauses while hidden and resumes a wake that arrived meanwhile", () => {
    const display = new FakeDisplay();
    const { scene, tick } = fakeScene();
    const governor = new RenderGovernor(tick, display);

    scene.dirtyFrames = Number.POSITIVE_INFINITY;
    governor.wake();
    display.advance(100);
    governor.setVisible(false);
    const hiddenAt = scene.ticks;
    expect(display.scheduled).toBe(0);
    governor.wake();
    display.advance(5_000);
    expect(scene.ticks).toBe(hiddenAt);

    governor.setVisible(true);
    display.advance(100);
    expect(scene.ticks).toBeGreaterThan(hiddenAt);
  });

  it("stops for good when disposed", () => {
    const display = new FakeDisplay();
    const { scene, tick } = fakeScene();
    const governor = new RenderGovernor(tick, display);
    scene.dirtyFrames = Number.POSITIVE_INFINITY;
    governor.wake();
    display.advance(50);
    governor.dispose();
    const ticks = scene.ticks;
    governor.wake();
    display.advance(1_000);
    expect(scene.ticks).toBe(ticks);
    expect(display.scheduled).toBe(0);
  });
});

describe("renderQuality", () => {
  it("renders at screen density up to 2x and uses MSAA only on low-density screens", () => {
    expect(renderQuality(1)).toEqual({ resolutionScale: 1, msaaSamples: 4 });
    expect(renderQuality(2)).toEqual({ resolutionScale: 1, msaaSamples: 1 });
    expect(renderQuality(3)).toEqual({ resolutionScale: 2 / 3, msaaSamples: 1 });
    expect(renderQuality(0)).toEqual({ resolutionScale: 1, msaaSamples: 4 });
  });
});
