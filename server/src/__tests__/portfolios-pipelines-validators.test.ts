import { describe, expect, it } from "vitest";
import { createPipelineSchema, createPortfolioSchema, updatePipelineSchema } from "@paperclipai/shared";

const agent = (agentId: string) => ({ type: "agent" as const, agentId });
const workStep = { key: "fix", kind: "work" as const, label: "Fix", participant: agent("11111111-1111-4111-8111-111111111111") };
const reviewStep = { key: "review", kind: "review" as const, label: "Review", participant: agent("22222222-2222-4222-8222-222222222222") };

describe("createPortfolioSchema", () => {
  it("accepts a minimal portfolio and defaults status to active", () => {
    const parsed = createPortfolioSchema.parse({ name: "Minion Code" });
    expect(parsed.status).toBe("active");
  });

  it("rejects an empty name", () => {
    expect(() => createPortfolioSchema.parse({ name: "" })).toThrow();
  });
});

describe("createPipelineSchema", () => {
  it("accepts a work→review pipeline with a trigger", () => {
    const parsed = createPipelineSchema.parse({
      name: "bugs",
      trigger: { originKinds: ["github_issue"] },
      steps: [workStep, reviewStep],
    });
    expect(parsed.steps).toHaveLength(2);
  });

  it("rejects two work steps", () => {
    expect(() =>
      createPipelineSchema.parse({ name: "bad", steps: [workStep, { ...workStep, key: "fix2" }] }),
    ).toThrow();
  });

  it("rejects a pipeline that does not start with a work step", () => {
    expect(() => createPipelineSchema.parse({ name: "bad", steps: [reviewStep] })).toThrow();
  });

  it("rejects an eval step without rubric/minScore/maxScore", () => {
    expect(() =>
      createPipelineSchema.parse({
        name: "bad",
        steps: [workStep, { key: "eval", kind: "eval", label: "Eval", participant: agent("33333333-3333-4333-8333-333333333333") }],
      }),
    ).toThrow();
  });

  it("rejects unknown trigger fields (strict)", () => {
    expect(() =>
      createPipelineSchema.parse({ name: "bad", steps: [workStep], trigger: { bogus: ["x"] } }),
    ).toThrow();
  });
});

describe("updatePipelineSchema", () => {
  it("allows archiving via nullable coerced date", () => {
    const parsed = updatePipelineSchema.parse({ archivedAt: "2026-07-11T00:00:00.000Z" });
    expect(parsed.archivedAt).toBeInstanceOf(Date);
    expect(updatePipelineSchema.parse({ archivedAt: null }).archivedAt).toBeNull();
  });

  it("re-validates steps on update", () => {
    expect(() => updatePipelineSchema.parse({ steps: [reviewStep] })).toThrow();
  });
});
