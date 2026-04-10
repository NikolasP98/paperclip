import { describe, it, expect } from "vitest";
import { buildInvestigationPrompt, buildFollowUpPrompt } from "../src/prompt.js";

describe("buildInvestigationPrompt", () => {
  it("includes issue details and service versions", () => {
    const prompt = buildInvestigationPrompt({
      number: 42,
      title: "Dashboard crashes on load",
      author: "nikolas",
      url: "https://github.com/openclaw/minion_hub/issues/42",
      body: "The dashboard crashes when loading the agents page.",
      repo: "openclaw/minion_hub",
      versions: [
        { serviceName: "minion_hub", version: "v.g89sf78", repo: "openclaw/minion_hub" },
        { serviceName: "minion-ai", version: "v2026.4.19-4", repo: "openclaw/minion-ai" },
      ],
    });

    expect(prompt).toContain("GitHub Issue #42");
    expect(prompt).toContain("Dashboard crashes on load");
    expect(prompt).toContain("nikolas");
    expect(prompt).toContain("minion_hub: v.g89sf78");
    expect(prompt).toContain("minion-ai: v2026.4.19-4");
    expect(prompt).toContain("Clone/checkout");
  });
});

describe("buildFollowUpPrompt", () => {
  it("includes comment context and paperclip issue reference", () => {
    const prompt = buildFollowUpPrompt({
      number: 42,
      commentAuthor: "nikolas",
      commentBody: "Actually this also affects the settings page.",
      paperclipIssueId: "abc-123",
    });

    expect(prompt).toContain("Follow-up on GitHub Issue #42");
    expect(prompt).toContain("nikolas");
    expect(prompt).toContain("settings page");
    expect(prompt).toContain("abc-123");
  });
});
