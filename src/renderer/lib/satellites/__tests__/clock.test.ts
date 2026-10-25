import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodicTicker, SATELLITE_UPDATE_MS, type TickerTimers } from "@renderer/lib/satellites/clock";

const timers: TickerTimers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
  now: () => Date.now()
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PeriodicTicker (satellite updates)", () => {
  it("runs nothing while it has nothing to move", () => {
    const tick = vi.fn();
    new PeriodicTicker(tick, SATELLITE_UPDATE_MS, timers);
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves the satellites at most once a second", () => {
    const tick = vi.fn();
    const ticker = new PeriodicTicker(tick, SATELLITE_UPDATE_MS, timers);
    ticker.setRunning(true);
    vi.advanceTimersByTime(0);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(11);
    // New data right after an update waits for the next one.
    vi.advanceTimersByTime(400);
    ticker.poke();
    expect(tick).toHaveBeenCalledTimes(11);
    vi.advanceTimersByTime(600);
    expect(tick).toHaveBeenCalledTimes(12);
    expect(SATELLITE_UPDATE_MS).toBe(1000);
  });

  it("moves the first data at once, and only once", () => {
    const tick = vi.fn();
    const ticker = new PeriodicTicker(tick, SATELLITE_UPDATE_MS, timers);
    // The adapter starts the ticker and pokes it when the first group is drawn.
    ticker.setRunning(true);
    ticker.poke();
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(0);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("pauses while the window is hidden and catches up once when shown", () => {
    const tick = vi.fn();
    const ticker = new PeriodicTicker(tick, SATELLITE_UPDATE_MS, timers);
    ticker.setRunning(true);
    vi.advanceTimersByTime(2_500);
    expect(tick).toHaveBeenCalledTimes(3);
    ticker.setVisible(false);
    ticker.poke();
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    ticker.setVisible(true);
    vi.advanceTimersByTime(0);
    expect(tick).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(5);
  });

  it("stops when the layer has no satellites and when disposed", () => {
    const tick = vi.fn();
    const ticker = new PeriodicTicker(tick, SATELLITE_UPDATE_MS, timers);
    ticker.setRunning(true);
    vi.advanceTimersByTime(1_500);
    ticker.setRunning(false);
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(2);
    ticker.setRunning(true);
    vi.advanceTimersByTime(0);
    expect(tick).toHaveBeenCalledTimes(3);
    ticker.dispose();
    ticker.setRunning(true);
    ticker.poke();
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
