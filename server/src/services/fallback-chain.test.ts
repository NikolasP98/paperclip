import { describe, it, expect } from "vitest";
import {
  resolveEffectiveChain,
  mergeAdapterChainLevelConfig,
  shouldAdvanceChain,
  classifyFallbackReason,
  parseQuotaResetAt,
} from "./fallback-chain.js";

const PRIMARY = { type: "claude_local", model: "anthropic/claude-sonnet-4-5" };
const SEC = {
  type: "pi_local",
  model: "openrouter/anthropic/claude-sonnet-4.5",
  envAlias: { OPENROUTER_API_KEY: "OPENROUTER_FALLBACK_API_KEY" },
};
const TER = {
  type: "pi_local",
  model: "openrouter/anthropic/claude-haiku-4.5",
  envAlias: { OPENROUTER_API_KEY: "OPENROUTER_TERTIARY_API_KEY" },
};

describe("resolveEffectiveChain", () => {
  it("returns just the primary when fallbackChain is missing", () => {
    expect(resolveEffectiveChain(PRIMARY, undefined)).toEqual([PRIMARY]);
    expect(resolveEffectiveChain(PRIMARY, [])).toEqual([PRIMARY]);
  });

  it("prepends primary to the fallback chain", () => {
    expect(resolveEffectiveChain(PRIMARY, [SEC, TER])).toEqual([PRIMARY, SEC, TER]);
  });
});

describe("mergeAdapterChainLevelConfig", () => {
  it("preserves the resolved primary env instead of restoring persisted bindings", () => {
    const resolvedEnv = {
      MINION_GATEWAY_URL: "wss://gateway.example.test/",
      MINION_GATEWAY_TOKEN: "resolved-token",
    };

    const merged = mergeAdapterChainLevelConfig(
      { droneId: "portfolio-issue-classifier-v1", env: resolvedEnv },
      {
        type: "minion_drone",
        droneId: "portfolio-issue-classifier-v1",
        env: {
          MINION_GATEWAY_URL: {
            type: "plain",
            value: "wss://gateway.example.test/",
          },
          MINION_GATEWAY_TOKEN: {
            type: "secret_ref",
            secretId: "11111111-1111-4111-8111-111111111111",
          },
        },
      },
      0,
    );

    expect(merged.env).toBe(resolvedEnv);
  });

  it("keeps explicit fallback-level overrides", () => {
    const fallbackEnv = { FALLBACK_TOKEN: "fallback" };
    const merged = mergeAdapterChainLevelConfig(
      { env: { PRIMARY_TOKEN: "primary" } },
      { type: "process", env: fallbackEnv },
      1,
    );

    expect(merged.env).toBe(fallbackEnv);
  });
});

describe("shouldAdvanceChain", () => {
  it("advances on claude quota error", () => {
    const result = {
      errorMessage:
        "Claude run failed: subtype=success: You're out of extra usage · resets Apr 23, 7pm UTC",
    };
    expect(shouldAdvanceChain(result, PRIMARY)).toBe(true);
  });

  it("does not advance on claude unrelated error", () => {
    const result = { errorMessage: "Claude exited with code 1" };
    expect(shouldAdvanceChain(result, PRIMARY)).toBe(false);
  });

  it("advances on pi credit-limit error", () => {
    const result = { errorCode: "openrouter_credit_limit" };
    expect(shouldAdvanceChain(result, SEC)).toBe(true);
  });

  it("does not advance on pi timeout", () => {
    const result = { timedOut: true, errorCode: "timeout" };
    expect(shouldAdvanceChain(result, SEC)).toBe(false);
  });
});

describe("classifyFallbackReason", () => {
  it("returns quota_exhausted for claude quota error", () => {
    expect(
      classifyFallbackReason({ errorMessage: "You're out of extra usage" }, PRIMARY),
    ).toBe("quota_exhausted");
  });

  it("returns credit_cap_hit for pi OR credit limit", () => {
    expect(
      classifyFallbackReason({ errorCode: "openrouter_credit_limit" }, SEC),
    ).toBe("credit_cap_hit");
  });

  it("returns null for non-fallback-triggering failures", () => {
    expect(classifyFallbackReason({ errorMessage: "some other error" }, PRIMARY)).toBe(null);
  });
});

describe("parseQuotaResetAt", () => {
  it("parses the Claude quota error reset timestamp", () => {
    const msg = "You're out of extra usage · resets Apr 23, 7pm UTC";
    const ts = parseQuotaResetAt(msg);
    expect(ts).toBeInstanceOf(Date);
    expect(ts!.toISOString()).toMatch(/-04-23T19:00:00/);
  });

  it("returns null when no reset timestamp is present", () => {
    expect(parseQuotaResetAt("some unrelated error")).toBeNull();
  });
});
