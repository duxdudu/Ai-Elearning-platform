import { describe, expect, it } from "vitest";
import { loadServicePort, loadSharedConfig } from "./index.js";

describe("service configuration", () => {
  it("rejects short internal identity secrets", () => {
    expect(() => loadSharedConfig({ INTERNAL_IDENTITY_SECRET: "short" })).toThrow();
  });

  it("validates service ports", () => {
    expect(loadServicePort("PORT", 4000, { PORT: "4100" })).toBe(4100);
    expect(() => loadServicePort("PORT", 4000, { PORT: "70000" })).toThrow();
  });
});
