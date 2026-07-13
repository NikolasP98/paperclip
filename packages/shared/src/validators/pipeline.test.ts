import { describe, expect, it } from "vitest";
import { ISSUE_ORIGIN_KINDS, ISSUE_PIPELINE_EVENT_TYPES } from "../constants.js";
import { createPipelineSchema, updatePipelineSchema } from "./pipeline.js";

const agent = (agentId: string) => ({ type: "agent" as const, agentId });
const user = (userId: string) => ({ type: "user" as const, userId });
const role = (...roleKeys: string[]) => ({ type: "role" as const, roleKeys });

const planStep = {
  key: "plan",
  kind: "work" as const,
  label: "Plan",
  participant: agent("11111111-1111-4111-8111-111111111111"),
};

const implementStep = {
  key: "implement",
  kind: "work" as const,
  label: "Implement",
  participant: agent("22222222-2222-4222-8222-222222222222"),
};

const evalStep = {
  key: "evaluate",
  kind: "eval" as const,
  label: "Evaluate",
  participant: agent("33333333-3333-4333-8333-333333333333"),
  rubric: "Score correctness and test coverage.",
  minScore: 7,
  maxScore: 10,
  onFailStepKey: "implement",
  maxAttempts: 3,
};

describe("pipeline execution contracts", () => {
  it("defaults existing pipelines to inline and preserves the single-work-step invariant", () => {
    const parsed = createPipelineSchema.parse({ name: "legacy", steps: [planStep] });
    expect(parsed.executionMode).toBe("inline");

    expect(() => createPipelineSchema.parse({ name: "legacy", steps: [planStep, implementStep] })).toThrow(
      /Inline pipelines allow exactly one work step/,
    );
  });

  it("accepts a traceable stage-task workflow with multiple workers and bounded eval retry", () => {
    const parsed = createPipelineSchema.parse({
      name: "repository issue",
      executionMode: "stage_tasks",
      steps: [
        planStep,
        {
          key: "plan_approval",
          kind: "approval",
          label: "Approve plan",
          participant: user("board"),
        },
        implementStep,
        evalStep,
      ],
    });

    expect(parsed.executionMode).toBe("stage_tasks");
    expect(parsed.steps).toHaveLength(4);
    expect(parsed.steps[3]?.maxAttempts).toBe(3);
  });

  it("allows approval gates to retry an earlier work step", () => {
    const parsed = createPipelineSchema.parse({
      name: "governed plan",
      executionMode: "stage_tasks",
      steps: [
        planStep,
        {
          key: "plan_approval",
          kind: "approval",
          label: "Approve plan",
          participant: user("board"),
          onFailStepKey: "plan",
          maxAttempts: 3,
        },
      ],
    });

    expect(parsed.steps[1]?.onFailStepKey).toBe("plan");
  });

  it("accepts bounded role-scoped HITL gates only in stage-task pipelines", () => {
    const parsed = createPipelineSchema.parse({
      name: "role governed plan",
      executionMode: "stage_tasks",
      steps: [
        planStep,
        {
          key: "plan_approval",
          kind: "approval",
          label: "Approve plan",
          participant: role("engineering_lead", "instance:admin"),
        },
      ],
    });
    expect(parsed.steps[1]?.participant).toEqual({
      type: "role",
      roleKeys: ["engineering_lead", "instance:admin"],
    });

    expect(() =>
      createPipelineSchema.parse({
        name: "inline role",
        steps: [planStep, {
          key: "approval",
          kind: "approval",
          label: "Approve",
          participant: role("owner"),
        }],
      }),
    ).toThrow(/Role participants require stage_tasks/);

    expect(() =>
      createPipelineSchema.parse({
        name: "role worker",
        executionMode: "stage_tasks",
        steps: [{ ...planStep, participant: role("engineer") }],
      }),
    ).toThrow(/Work step participant must be an agent/);
  });

  it("requires retry fields together and points retries to an earlier work step", () => {
    expect(() =>
      createPipelineSchema.parse({
        name: "missing bound",
        executionMode: "stage_tasks",
        steps: [planStep, { ...evalStep, maxAttempts: undefined }],
      }),
    ).toThrow(/configured together/);

    expect(() =>
      createPipelineSchema.parse({
        name: "unknown target",
        executionMode: "stage_tasks",
        steps: [planStep, { ...evalStep, onFailStepKey: "missing" }],
      }),
    ).toThrow(/reference a pipeline step/);

    expect(() =>
      createPipelineSchema.parse({
        name: "forward target",
        executionMode: "stage_tasks",
        steps: [planStep, { ...evalStep, onFailStepKey: "late" }, { ...implementStep, key: "late" }],
      }),
    ).toThrow(/reference an earlier step/);
  });

  it("rejects duplicate stage keys and requires an explicit mode when updating to multiple workers", () => {
    expect(() =>
      createPipelineSchema.parse({
        name: "duplicates",
        executionMode: "stage_tasks",
        steps: [planStep, { ...implementStep, key: "plan" }],
      }),
    ).toThrow(/Step keys must be unique/);

    expect(() => updatePipelineSchema.parse({ steps: [planStep, implementStep] })).toThrow(
      /Inline pipelines allow exactly one work step/,
    );
    expect(
      updatePipelineSchema.parse({ executionMode: "stage_tasks", steps: [planStep, implementStep] }).executionMode,
    ).toBe("stage_tasks");
  });

  it("recognizes GitHub parents and generated pipeline children as built-in origins", () => {
    expect(ISSUE_ORIGIN_KINDS).toContain("github_issue");
    expect(ISSUE_ORIGIN_KINDS).toContain("pipeline_step");
    expect(ISSUE_PIPELINE_EVENT_TYPES).toContain("run_blocked");
  });
});
