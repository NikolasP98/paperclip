import { describe, expect, it } from "vitest";
import { agentHarnessIdsQuerySchema, roleRoutingPolicySchema } from "./agent-harness.js";
describe("agent harness validators", () => {
  it("caps and deduplicates batch ids", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(agentHarnessIdsQuerySchema.parse({ agentIds: `${id},${id}` }).agentIds).toEqual([id]);
    expect(
      agentHarnessIdsQuerySchema.safeParse({
        agentIds: Array.from(
          { length: 51 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ).join(","),
      }).success,
    ).toBe(false);
  });
  it("validates measured routing objectives", () => {
    expect(
      roleRoutingPolicySchema.safeParse({
        roleKey: "implementer",
        runtimeClass: "coding",
        primaryAdapterType: "codex_local",
        primaryModel: "gpt-5.3-codex",
        fallbackModels: [],
        tools: [],
        skills: [],
        proposalScoreThreshold: 7,
        scoreFloor: 7,
        maxLatencyMs: 1000,
        maxFallbackRate: 0.2,
        maxCostPerAcceptedOutcomeCents: 100,
      }).success,
    ).toBe(true);
  });
});
