import { describe, expect, it } from "vitest";
import {
  deriveHarnessPerformance,
  harnessContentHash,
  harnessPolicyPreset,
  observedHarnessConfig,
  redactHarnessValue,
  roleKeyForAgent,
} from "./agent-harness.js";

describe("agent living harness", () => {
  it("routes governed roles to explicit recommendations without changing active runtime", () => {
    const implementer = harnessPolicyPreset({
      name: "bug-fixer",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-5" },
    });
    expect(implementer.roleKey).toBe("implementer");
    expect(implementer.runtime.active.primary).toMatchObject({
      adapterType: "claude_local",
      model: "claude-sonnet-4-5",
      executable: true,
    });
    expect(implementer.runtime.recommended.primary).toMatchObject({
      adapterType: "opencode_local",
      model: "github-copilot/claude-sonnet-5",
    });
    expect(implementer.runtime.recommended.fallbacks[0]).toMatchObject({
      adapterType: "codex_local",
      model: "gpt-5.3-codex",
    });
    expect(implementer.runtime.objectives.scoreFloor).toBe(7);
    const monitor = harnessPolicyPreset({
      name: "portfolio-monitor",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    expect(monitor.runtime.recommended.primary).toMatchObject({
      runtimeKind: "minion_drone",
      executable: false,
      bridgePending: true,
    });
    const classifier = harnessPolicyPreset({
      name: "issue-classifier",
      adapterType: "claude_local",
      adapterConfig: {},
    });
    expect(classifier.runtime.recommended.primary).toMatchObject({
      runtimeKind: "minion_drone",
      model: "claude-haiku-4-5",
      bridgePending: true,
    });
    expect(implementer.runtime.activeCapabilities).toEqual({
      tools: ["edit", "git", "github", "read", "shell"],
      skills: [
        "systematic-debugging",
        "test-driven-development",
        "verification-before-completion",
      ],
    });
    expect(roleKeyForAgent({ name: "anything" })).toBe("generic");
  });

  it("allowlists observed configuration and never persists secret values or arbitrary args", () => {
    const observed = observedHarnessConfig({
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        timeoutSec: 60,
        env: { API_KEY: "sk-live-secret", NORMAL: "also-not-persisted" },
        authToken: "bearer-secret",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        headers: { authorization: "secret" },
        extraArgs: ["--header", "super-secret-positional"],
        instructionsFilePath: "/secret/path/AGENTS.md",
        fallbackChain: [{ type: "codex_local", model: "gpt-5.4", env: { TOKEN: "secret" } }],
      },
    });
    const encoded = JSON.stringify(observed);
    expect(encoded).not.toContain("sk-live-secret");
    expect(encoded).not.toContain("super-secret-positional");
    expect(encoded).not.toContain("BEGIN PRIVATE KEY");
    expect(encoded).not.toContain("/secret/path");
    expect(observed.envKeys).toEqual(["API_KEY", "NORMAL"]);
    expect(observed.instructionPathHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redacts nested secret-looking keys defensively", () => {
    expect(redactHarnessValue({ nested: { apiKey: "x", safe: "y" }, token: "z" })).toEqual({
      nested: { apiKey: "***REDACTED***", safe: "y" },
      token: "***REDACTED***",
    });
  });
  it("retains fractional scores without changing the immutable configuration hash", () => {
    const snapshot = { roleKey: "implementer", observed: { model: "x" } };
    const before = harnessContentHash(snapshot);
    const performance = deriveHarnessPerformance([
      { score: 6.5, outcome: "changes_requested" },
      { score: 8, outcome: "approved" },
    ]);
    expect(performance.averageScore).toBe(7.25);
    expect(performance.changesRequestedCount).toBe(1);
    expect(harnessContentHash(snapshot)).toBe(before);
  });
});
