import { describe, expect, it } from "vitest";
import { ROUTE, makeHop } from "@renderer/test/fixtures";
import { LATENCY_JUMP_MS, buildTimeline, describeTimelineHop, formatMs } from "../timeline";

describe("buildTimeline", () => {
  const { hops, scaleMs } = buildTimeline(ROUTE);
  const hop = (index: number) => hops.find((item) => item.hopIndex === index);

  it("keeps every hop with its RTT stats, probe samples and loss", () => {
    expect(hops.map((item) => item.hopIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hop(3)).toMatchObject({
      address: "180.87.38.5",
      avgMs: 30.5,
      minMs: 30,
      maxMs: 31,
      samplesMs: [30, 30.5, 31],
      lossPercent: 0
    });
    expect(hop(4)).toMatchObject({ address: null, avgMs: null, samplesMs: [], lossPercent: 100 });
    expect(scaleMs).toBe(113);
  });

  it("marks a rise of the average RTT over the previous hop that answered", () => {
    expect(LATENCY_JUMP_MS).toBe(20);
    expect(hop(2)?.jumpMs).toBeNull();
    expect(hop(3)).toMatchObject({ jumpMs: 26, jumpFromHopIndex: 2 });
    // Hop 4 did not answer; hop 5 is compared with hop 3.
    expect(hop(4)?.jumpMs).toBeNull();
    expect(hop(5)).toMatchObject({ jumpMs: 81, jumpFromHopIndex: 3 });
    // 1 ms more is not a jump.
    expect(hop(6)?.jumpMs).toBeNull();
    // A drop is never a jump.
    const drop = buildTimeline([makeHop(1, "192.0.2.1", 90), makeHop(2, "192.0.2.2", 10)]);
    expect(drop.hops[1].jumpMs).toBeNull();
  });

  it("says where each hop is and how sure the estimate is", () => {
    expect(hop(1)?.location).toEqual({ kind: "private" });
    expect(hop(2)?.location).toEqual({ kind: "located", label: "Mumbai, India", confidence: "medium" });
    expect(hop(4)?.location).toEqual({ kind: "unknown" });
    expect(hop(6)?.location).toEqual({ kind: "anycast", service: "Google Public DNS" });
    expect(
      buildTimeline([makeHop(1, "192.0.2.9", 5, { lookupState: "pending" })]).hops[0].location
    ).toEqual({ kind: "pending" });
  });

  it("describes a hop for screen readers", () => {
    expect(describeTimelineHop(hop(5)!)).toBe(
      "Hop 5, 80.231.217.17, Marseille, France, high confidence, RTT 112 ms (min 111, max 112), 33% loss, 81 ms more than hop 3"
    );
    expect(describeTimelineHop(hop(4)!)).toBe("Hop 4, no reply, location unknown, 100% loss");
  });

  it("formats milliseconds to whole numbers from 10 ms", () => {
    expect(formatMs(4.5)).toBe("4.5");
    expect(formatMs(111.5)).toBe("112");
    expect(formatMs(0.25)).toBe("0.3");
  });
});
