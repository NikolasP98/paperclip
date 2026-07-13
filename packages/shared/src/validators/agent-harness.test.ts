import { describe, expect, it } from "vitest";
import {
  agentHarnessIdsQuerySchema,
  harnessGuidanceChangeSchema,
  roleRoutingPolicySchema,
} from "./agent-harness.js";
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
  it("accepts only bounded secret-free role guidance replacements", () => {
    const valid = {
      kind: "replace_role_guidance",
      baseRevisionId: "11111111-1111-4111-8111-111111111111",
      before: "Read the issue evidence and implement only the approved scope.",
      after: "Read the issue evidence, add a regression test, and implement only the approved scope.",
    };
    expect(harnessGuidanceChangeSchema.parse(valid)).toEqual(valid);
    expect(harnessGuidanceChangeSchema.safeParse({ ...valid, model: "gpt-5.4" }).success).toBe(
      false,
    );
    expect(
      harnessGuidanceChangeSchema.safeParse({
        ...valid,
        after: "Use API_KEY=sk_live_12345678901234567890 for the evaluator.",
      }).success,
    ).toBe(false);
    expect(harnessGuidanceChangeSchema.safeParse({ ...valid, after: "too short" }).success).toBe(
      false,
    );
  });
});
