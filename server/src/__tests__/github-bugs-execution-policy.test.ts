import { describe, expect, it } from "vitest";
import { buildBugExecutionPolicy, type GithubBugsDeps } from "../routes/github-bugs.js";

const base: GithubBugsDeps = {
  heartbeat: {} as GithubBugsDeps["heartbeat"],
  repoSandbox: null,
  secret: "s",
  companyId: "c",
  agentId: "a",
  bugRepo: "o/r",
};

describe("buildBugExecutionPolicy", () => {
  it("returns undefined when no stage participants are configured", () => {
    expect(buildBugExecutionPolicy(base)).toBeUndefined();
  });

  it("builds review (agent) then approval (user) stages in pipeline order", () => {
    const policy = buildBugExecutionPolicy({
      ...base,
      reviewerAgentId: "reviewer-agent",
      approverUserId: "hitl-user",
    });
    expect(policy).toMatchObject({ mode: "normal", commentRequired: true });
    expect(policy?.stages.map((s) => s.type)).toEqual(["review", "approval"]);
    expect(policy?.stages[0]?.participants).toEqual([
      expect.objectContaining({ type: "agent", agentId: "reviewer-agent" }),
    ]);
    expect(policy?.stages[1]?.participants).toEqual([
      expect.objectContaining({ type: "user", userId: "hitl-user" }),
    ]);
    // ids must be present — the normalizer dedupes/validates on them
    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toBeTruthy();
      expect(stage.approvalsNeeded).toBe(1);
    }
  });

  it("omits the review stage when only the HITL approver is configured", () => {
    const policy = buildBugExecutionPolicy({ ...base, approverUserId: "hitl-user" });
    expect(policy?.stages.map((s) => s.type)).toEqual(["approval"]);
  });
});
