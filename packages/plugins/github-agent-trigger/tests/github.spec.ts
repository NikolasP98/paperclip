import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifySignature } from "../src/github.js";

describe("verifySignature", () => {
  const secret = "test-webhook-secret";

  it("accepts valid HMAC-SHA256 signature", () => {
    const body = '{"action":"opened"}';
    const hmac = createHmac("sha256", secret).update(body).digest("hex");
    const signature = `sha256=${hmac}`;
    expect(verifySignature(body, signature, secret)).toBe(true);
  });

  it("rejects invalid signature", () => {
    const body = '{"action":"opened"}';
    const signature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    expect(verifySignature(body, signature, secret)).toBe(false);
  });

  it("rejects missing sha256= prefix", () => {
    const body = '{"action":"opened"}';
    const hmac = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(body, hmac, secret)).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(verifySignature("{}", "", secret)).toBe(false);
  });
});
