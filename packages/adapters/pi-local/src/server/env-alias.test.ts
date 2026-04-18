import { describe, it, expect } from "vitest";
import { applyEnvAlias } from "./env-alias.js";

describe("applyEnvAlias", () => {
  it("returns env unchanged when no alias config is provided", () => {
    const env = { FOO: "bar", BAZ: "qux" };
    expect(applyEnvAlias(env, undefined)).toEqual(env);
    expect(applyEnvAlias(env, {})).toEqual(env);
  });

  it("rewrites the destination env var to the value of the source", () => {
    const env = {
      OPENROUTER_API_KEY: "primary-key",
      OPENROUTER_FALLBACK_API_KEY: "fallback-key",
    };
    const out = applyEnvAlias(env, { OPENROUTER_API_KEY: "OPENROUTER_FALLBACK_API_KEY" });
    expect(out.OPENROUTER_API_KEY).toBe("fallback-key");
    expect(out.OPENROUTER_FALLBACK_API_KEY).toBe("fallback-key");
  });

  it("leaves dest unchanged if source key is missing or empty", () => {
    const env = { OPENROUTER_API_KEY: "primary-key" };
    const out = applyEnvAlias(env, { OPENROUTER_API_KEY: "MISSING_KEY" });
    expect(out.OPENROUTER_API_KEY).toBe("primary-key");
  });

  it("supports multiple aliases at once", () => {
    const env = { A: "1", B: "2", C: "src-c" };
    const out = applyEnvAlias(env, { A: "C", B: "C" });
    expect(out.A).toBe("src-c");
    expect(out.B).toBe("src-c");
    expect(out.C).toBe("src-c");
  });
});
