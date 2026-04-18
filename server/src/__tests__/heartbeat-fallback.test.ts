import { describe, it, expect } from "vitest";
import { resolveEffectiveChain, shouldAdvanceChain } from "../services/fallback-chain.js";

// Integration contract between the chain helpers and the dispatch behavior in
// heartbeat.ts. Full E2E with a live DB lives elsewhere; this pins the
// adapter-level dispatch decision points so heartbeat.ts can rely on them.

describe("fallback chain dispatch contract", () => {
  it("advances level → stops when an adapter succeeds", () => {
    const chain = resolveEffectiveChain(
      { type: "claude_local" },
      [{ type: "pi_local", model: "openrouter/anthropic/claude-sonnet-4.5" }],
    );

    const claudeResult = {
      errorMessage: "You're out of extra usage · resets Apr 23, 7pm UTC",
    };
    expect(shouldAdvanceChain(claudeResult, chain[0])).toBe(true);

    const piResult = { errorMessage: null, errorCode: null, timedOut: false };
    expect(shouldAdvanceChain(piResult, chain[1])).toBe(false);
  });

  it("does NOT advance on non-quota claude errors", () => {
    const claudeResult = { errorMessage: "Some other error" };
    expect(shouldAdvanceChain(claudeResult, { type: "claude_local" })).toBe(false);
  });

  it("does NOT advance on pi timeout (only credit-limit triggers fallback)", () => {
    const piResult = { timedOut: true, errorCode: "timeout" };
    expect(shouldAdvanceChain(piResult, { type: "pi_local" })).toBe(false);
  });
});
