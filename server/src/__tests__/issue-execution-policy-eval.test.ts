import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

// Pure tests for the eval score gate (spec §2.4): call applyIssueExecutionPolicyTransition
// directly with fabricated issue/policy/state objects — no DB. Mirrors the fabrication
// style in issue-execution-policy.test.ts.

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const evaluatorAgentId = "44444444-4444-4444-8444-444444444444";
const reviewerAgentId = "22222222-2222-4222-8222-222222222222";

function makePolicy(
  stages: Array<{
    type: "review" | "approval";
    participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }>;
    meta?: { kind?: string; minScore?: number | null; maxScore?: number | null; rubric?: string | null };
  }>,
) {
  return normalizeIssueExecutionPolicy({ stages })!;
}

function evalOnlyPolicy(minScore = 7) {
  return makePolicy([
    {
      type: "review",
      participants: [{ type: "agent", agentId: evaluatorAgentId }],
      meta: { kind: "eval", minScore, maxScore: 10, rubric: "Score the diff." },
    },
  ]);
}

function evalThenReviewPolicy(minScore = 7) {
  return makePolicy([
    {
      type: "review",
      participants: [{ type: "agent", agentId: evaluatorAgentId }],
      meta: { kind: "eval", minScore, maxScore: 10, rubric: "Score the diff." },
    },
    { type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] },
  ]);
}

function legacyReviewOnlyPolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] },
  ]);
}

describe("normalizeIssueExecutionPolicy — eval meta passthrough", () => {
  it("round-trips stage.meta (kind/minScore/maxScore/rubric)", () => {
    const policy = evalOnlyPolicy();
    expect(policy.stages[0].meta).toEqual({
      kind: "eval",
      minScore: 7,
      maxScore: 10,
      rubric: "Score the diff.",
    });
  });

  it("leaves meta absent on stages that don't declare it", () => {
    const policy = legacyReviewOnlyPolicy();
    expect(policy.stages[0].meta).toBeUndefined();
  });
});

describe("eval score gate — applyIssueExecutionPolicyTransition", () => {
  it("legacy policy without meta: done + comment still approves (regression)", () => {
    const policy = legacyReviewOnlyPolicy();
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
      commentBody: "Looks good",
    });

    expect(result.decision).toMatchObject({ outcome: "approved" });
    expect(result.decision?.score).toBeUndefined();
    expect(result.decision?.maxScore).toBeUndefined();
  });

  it("eval stage + done + no evalScore throws", () => {
    const policy = evalOnlyPolicy();
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: evaluatorAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: policy.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: evaluatorAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: evaluatorAgentId },
        commentBody: "Evaluated",
        // evalScore intentionally omitted
      }),
    ).toThrow("Eval stage requires a score");
  });

  it("eval stage + done + evalScore below minScore + comment bounces to changes_requested with score persisted", () => {
    const policy = evalOnlyPolicy(7);
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: evaluatorAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: evaluatorAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: evaluatorAgentId },
      commentBody: "Needs work — root cause not addressed",
      evalScore: 4,
    });

    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    expect(result.patch.executionState).toMatchObject({ status: "changes_requested" });
    expect(result.decision).toMatchObject({
      outcome: "changes_requested",
      score: 4,
      maxScore: 10,
    });
  });

  it("eval stage + done + evalScore >= minScore + comment approves and advances to the next stage", () => {
    const policy = evalThenReviewPolicy(7);
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: evaluatorAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: evaluatorAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: evaluatorAgentId },
      commentBody: "Solid fix, root cause addressed",
      evalScore: 9,
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(reviewerAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
    });
    expect(result.decision).toMatchObject({
      outcome: "approved",
      score: 9,
      maxScore: 10,
    });
  });

  it("eval stage + done + evalScore exactly at minScore approves (>= boundary)", () => {
    const policy = evalOnlyPolicy(7);
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: evaluatorAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: evaluatorAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: evaluatorAgentId },
      commentBody: "Meets the bar exactly",
      evalScore: 7,
    });

    expect(result.decision).toMatchObject({ outcome: "approved", score: 7, maxScore: 10 });
  });

  it("non-eval stage: evalScore present is ignored (approve path unchanged, no score on decision)", () => {
    const policy = legacyReviewOnlyPolicy();
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
      commentBody: "Approved, score is noise here",
      evalScore: 1, // would be "below minScore" if this were an eval stage — must be ignored
    });

    expect(result.decision).toMatchObject({ outcome: "approved" });
    expect(result.decision?.score).toBeUndefined();
    expect(result.decision?.maxScore).toBeUndefined();
  });
});
