import { describe, expect, it } from "vitest";
import { INTEGRATION_DEFAULTS, normalizeIntegrations } from "../integrationSettings";

describe("normalizeIntegrations", () => {
  it("turns exchange matching on by default and keeps PeeringDB off", () => {
    expect(INTEGRATION_DEFAULTS.ixMatching.enabled).toBe(true);
    expect(INTEGRATION_DEFAULTS.peeringDb.enabled).toBe(false);
    expect(normalizeIntegrations(undefined)).toEqual(INTEGRATION_DEFAULTS);
  });

  it("keeps exchange matching on for settings saved before the switch existed", () => {
    const saved = normalizeIntegrations({
      teamCymru: { enabled: false },
      rdap: { enabled: true, baseUrl: "https://rdap.example.net/ip" },
      ripeStat: { enabled: true, sourceApp: "VisTracer" },
      peeringDb: { enabled: false, apiKey: "k" }
    });
    expect(saved.ixMatching).toEqual({ enabled: true });
    expect(saved.teamCymru.enabled).toBe(false);
    expect(saved.peeringDb).toEqual({ enabled: false, apiKey: "k" });
  });

  it("keeps exchange matching off when the user turned it off", () => {
    expect(normalizeIntegrations({ ixMatching: { enabled: false } }).ixMatching.enabled).toBe(
      false
    );
  });
});
