import { describe, expect, it } from "vitest";
import { buildFailureComment, parseGithubOrigin } from "./github-bugs-notify.js";

describe("parseGithubOrigin", () => {
  it("splits owner/repo#number", () => {
    expect(parseGithubOrigin("NikolasP98/minion_hub#12")).toEqual({
      repo: "NikolasP98/minion_hub",
      number: 12,
    });
  });
  it("returns null for malformed ids", () => {
    expect(parseGithubOrigin("nope")).toBeNull();
  });
});

describe("buildFailureComment", () => {
  it("mentions the run and reason", () => {
    const c = buildFailureComment({ runId: "r1", reason: "adapter exited 1" });
    expect(c).toContain("Automated triage failed");
    expect(c).toContain("adapter exited 1");
  });
});
