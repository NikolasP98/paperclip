import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pickSeverity, verifyGitHubSignature } from "./github-bugs.js";

describe("verifyGitHubSignature", () => {
  const secret = "s3cret";
  const body = Buffer.from('{"a":1}');
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a valid signature", () => {
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true);
  });
  it("rejects a wrong signature", () => {
    expect(verifyGitHubSignature(body, "sha256=" + "0".repeat(64), secret)).toBe(false);
  });
  it("rejects missing/malformed signatures", () => {
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
    expect(verifyGitHubSignature(body, "sha1=abc", secret)).toBe(false);
  });
});

describe("pickSeverity", () => {
  it("maps a severity label to priority, defaulting medium", () => {
    expect(pickSeverity(["bug", "critical", "agent"])).toBe("critical");
    expect(pickSeverity(["bug", "low"])).toBe("low");
    expect(pickSeverity(["bug"])).toBe("medium");
  });
});
