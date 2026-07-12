import { describe, expect, it } from "vitest";
import type { Pipeline, PipelineStep, PipelineTrigger } from "@paperclipai/shared";
import {
  applyPipelineToCreateInput,
  compilePipeline,
  matchTrigger,
  rankPipelineCandidates,
  type PipelineApplyTarget,
} from "../services/pipelines.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "pipeline-1",
    companyId: "company-1",
    projectId: null,
    name: "test-pipeline",
    description: null,
    trigger: null,
    steps: [],
    sortOrder: 0,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const workStep: PipelineStep = {
  key: "fix",
  kind: "work",
  label: "Fix",
  participant: { type: "agent", agentId: "fixer-agent" },
};

const reviewStep: PipelineStep = {
  key: "review",
  kind: "review",
  label: "Review",
  participant: { type: "agent", agentId: "reviewer-agent" },
};

const approvalStep: PipelineStep = {
  key: "approve",
  kind: "approval",
  label: "Approval",
  participant: { type: "user", userId: "hitl-user" },
};

const evalStep: PipelineStep = {
  key: "eval",
  kind: "eval",
  label: "Eval",
  participant: { type: "agent", agentId: "evaluator-agent" },
  rubric: "Score the diff for root-cause fixes.",
  minScore: 7,
  maxScore: 10,
};

describe("compilePipeline", () => {
  it("compiles a 3-step bug pipeline to an assignee + review + approval stages", () => {
    const pipeline = makePipeline({ steps: [workStep, reviewStep, approvalStep] });
    const compiled = compilePipeline(pipeline);

    expect(compiled.assigneeAgentId).toBe("fixer-agent");
    expect(compiled.executionPolicy).not.toBeNull();
    expect(compiled.executionPolicy?.mode).toBe("normal");
    expect(compiled.executionPolicy?.commentRequired).toBe(true);
    expect(compiled.executionPolicy?.stages).toHaveLength(2);
    expect(compiled.executionPolicy?.stages[0]).toMatchObject({
      type: "review",
      approvalsNeeded: 1,
      participants: [expect.objectContaining({ type: "agent", agentId: "reviewer-agent" })],
    });
    expect(compiled.executionPolicy?.stages[1]).toMatchObject({
      type: "approval",
      participants: [expect.objectContaining({ type: "user", userId: "hitl-user" })],
    });
    // ids present on every stage + participant — normalizer/zod require them
    for (const stage of compiled.executionPolicy?.stages ?? []) {
      expect(stage.id).toBeTruthy();
      for (const participant of stage.participants) {
        expect(participant.id).toBeTruthy();
      }
    }
  });

  it("carries eval meta (kind/minScore/maxScore/rubric) on the compiled stage, and it survives normalizeIssueExecutionPolicy (WP3)", () => {
    const pipeline = makePipeline({ steps: [workStep, evalStep] });
    const compiled = compilePipeline(pipeline);
    const [stage] = compiled.executionPolicy?.stages ?? [];

    expect(stage?.type).toBe("review");
    expect(stage?.meta).toEqual({
      kind: "eval",
      minScore: 7,
      maxScore: 10,
      rubric: "Score the diff for root-cause fixes.",
    });

    // meta is additive on IssueExecutionStage — normalizeIssueExecutionPolicy passes it
    // through unchanged instead of stripping it (the round-trip an issue create/update
    // hits via routes/issues.ts normalizeIssueExecutionPolicy(createBody.executionPolicy)).
    // normalizeIssueExecutionPolicy validates participant ids as UUIDs (unlike the pure
    // compilePipeline fixtures above, which use human-readable ids), so build the
    // round-trip input with a real uuid participant.
    const uuidEvalPipeline = makePipeline({
      steps: [
        workStep,
        { ...evalStep, participant: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" } },
      ],
    });
    const normalized = normalizeIssueExecutionPolicy(compilePipeline(uuidEvalPipeline).executionPolicy);
    expect(normalized?.stages[0]?.meta).toEqual({
      kind: "eval",
      minScore: 7,
      maxScore: 10,
      rubric: "Score the diff for root-cause fixes.",
    });
  });

  it("threads the work step's adapterOverrides into assigneeAdapterOverrides.adapterConfig", () => {
    const pipeline = makePipeline({
      steps: [{ ...workStep, adapterOverrides: { model: "opus" } }],
    });
    const compiled = compilePipeline(pipeline);

    expect(compiled.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "opus" } });
  });

  it("returns a null executionPolicy and no adapter overrides for a work-only pipeline", () => {
    const pipeline = makePipeline({ steps: [workStep] });
    const compiled = compilePipeline(pipeline);

    expect(compiled.assigneeAgentId).toBe("fixer-agent");
    expect(compiled.assigneeAdapterOverrides).toBeNull();
    expect(compiled.executionPolicy).toBeNull();
  });
});

describe("applyPipelineToCreateInput", () => {
  const pipeline = makePipeline({ id: "pipeline-42", steps: [workStep, reviewStep] });

  it("stamps assignee, executionPolicy, and pipelineId onto an empty input", () => {
    const input: PipelineApplyTarget = {};
    const applied = applyPipelineToCreateInput(pipeline, input);

    expect(applied.pipelineId).toBe("pipeline-42");
    expect(applied.assigneeAgentId).toBe("fixer-agent");
    expect(applied.executionPolicy).not.toBeNull();
  });

  it("never overwrites an explicit assignee", () => {
    const input: PipelineApplyTarget = { assigneeAgentId: "explicit-agent" };
    const applied = applyPipelineToCreateInput(pipeline, input);

    expect(applied.assigneeAgentId).toBe("explicit-agent");
  });

  it("never overwrites an explicit executionPolicy — explicit policy always wins", () => {
    const explicitPolicy = { mode: "normal", commentRequired: true, stages: [] };
    const input: PipelineApplyTarget = { executionPolicy: explicitPolicy };
    const applied = applyPipelineToCreateInput(pipeline, input);

    expect(applied.executionPolicy).toBe(explicitPolicy);
    // assignee still fills in independently — only executionPolicy was pinned
    expect(applied.assigneeAgentId).toBe("fixer-agent");
  });

  it("never overwrites explicit assigneeAdapterOverrides", () => {
    const explicitOverrides = { adapterConfig: { model: "explicit" } };
    const input: PipelineApplyTarget = { assigneeAdapterOverrides: explicitOverrides };
    const pipelineWithOverrides = makePipeline({
      steps: [{ ...workStep, adapterOverrides: { model: "from-pipeline" } }],
    });
    const applied = applyPipelineToCreateInput(pipelineWithOverrides, input);

    expect(applied.assigneeAdapterOverrides).toBe(explicitOverrides);
  });

  it("is a no-op for assignee/policy on a work-only pipeline, but still stamps pipelineId", () => {
    const workOnly = makePipeline({ id: "pipeline-work-only", steps: [{ ...workStep, participant: { type: "agent", agentId: "solo-agent" } }] });
    const input: PipelineApplyTarget = {};
    const applied = applyPipelineToCreateInput(workOnly, input);

    expect(applied.pipelineId).toBe("pipeline-work-only");
    expect(applied.assigneeAgentId).toBe("solo-agent");
    expect(applied.executionPolicy).toBeUndefined();
  });
});

describe("matchTrigger", () => {
  it("matches everything when the trigger is null or empty", () => {
    expect(matchTrigger(null, {})).toBe(true);
    expect(matchTrigger({}, { originKind: "github_issue", labels: ["bug"], priority: "high" })).toBe(true);
  });

  it("matches originKinds when present in ctx", () => {
    const trigger: PipelineTrigger = { originKinds: ["manual"] };
    expect(matchTrigger(trigger, { originKind: "manual" })).toBe(true);
    expect(matchTrigger(trigger, { originKind: "routine_execution" })).toBe(false);
    expect(matchTrigger(trigger, {})).toBe(false);
  });

  it("matches labels via intersection (any overlap matches)", () => {
    const trigger: PipelineTrigger = { labels: ["bug", "urgent"] };
    expect(matchTrigger(trigger, { labels: ["urgent", "other"] })).toBe(true);
    expect(matchTrigger(trigger, { labels: ["other"] })).toBe(false);
    expect(matchTrigger(trigger, {})).toBe(false);
  });

  it("matches priorities when present in ctx", () => {
    const trigger: PipelineTrigger = { priorities: ["critical", "high"] };
    expect(matchTrigger(trigger, { priority: "high" })).toBe(true);
    expect(matchTrigger(trigger, { priority: "low" })).toBe(false);
    expect(matchTrigger(trigger, {})).toBe(false);
  });

  it("requires every present field to match (AND semantics)", () => {
    const trigger: PipelineTrigger = { originKinds: ["manual"], priorities: ["high"] };
    expect(matchTrigger(trigger, { originKind: "manual", priority: "high" })).toBe(true);
    expect(matchTrigger(trigger, { originKind: "manual", priority: "low" })).toBe(false);
    expect(matchTrigger(trigger, { originKind: "routine_execution", priority: "high" })).toBe(false);
  });
});

describe("rankPipelineCandidates (specificity ordering)", () => {
  it("prefers project-scoped over company-level", () => {
    const companyLevel = makePipeline({ id: "company", projectId: null });
    const projectScoped = makePipeline({ id: "project", projectId: "proj-1" });
    const ranked = rankPipelineCandidates([companyLevel, projectScoped]);
    expect(ranked[0]?.id).toBe("project");
  });

  it("within the same scope, prefers more specific triggers", () => {
    const broad = makePipeline({ id: "broad", trigger: { originKinds: ["manual"] } });
    const narrow = makePipeline({
      id: "narrow",
      trigger: { originKinds: ["manual"], labels: ["bug"] },
    });
    const ranked = rankPipelineCandidates([broad, narrow]);
    expect(ranked[0]?.id).toBe("narrow");
  });

  it("ties break on lowest sortOrder, then earliest createdAt", () => {
    const later = makePipeline({ id: "later", sortOrder: 0, createdAt: new Date("2026-02-01") });
    const earlier = makePipeline({ id: "earlier", sortOrder: 0, createdAt: new Date("2026-01-01") });
    const higherSort = makePipeline({ id: "higher-sort", sortOrder: 5, createdAt: new Date("2025-01-01") });
    const ranked = rankPipelineCandidates([higherSort, later, earlier]);
    expect(ranked.map((p) => p.id)).toEqual(["earlier", "later", "higher-sort"]);
  });
});
