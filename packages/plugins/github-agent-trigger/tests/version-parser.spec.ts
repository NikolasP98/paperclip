import { describe, it, expect } from "vitest";
import { parseVersions } from "../src/version-parser.js";

const repoMap: Record<string, string> = {
  minion_hub: "openclaw/minion_hub",
  "minion-ai": "openclaw/minion-ai",
  minion_site: "openclaw/minion_site",
};

describe("parseVersions", () => {
  describe("template format", () => {
    it("parses structured ### Services section", () => {
      const body = `
## Bug Report
Something is broken.

### Services
- minion_hub: v.g89sf78
- minion-ai: v2026.4.19-4

### Steps to reproduce
1. Do something
`;
      const result = parseVersions(body, repoMap);
      expect(result).toEqual([
        { serviceName: "minion_hub", version: "v.g89sf78", repo: "openclaw/minion_hub" },
        { serviceName: "minion-ai", version: "v2026.4.19-4", repo: "openclaw/minion-ai" },
      ]);
    });

    it("ignores unknown service names in template", () => {
      const body = `
### Services
- minion_hub: v.abc123
- unknown_service: v1.0.0
`;
      const result = parseVersions(body, repoMap);
      expect(result).toEqual([
        { serviceName: "minion_hub", version: "v.abc123", repo: "openclaw/minion_hub" },
      ]);
    });
  });

  describe("regex fallback", () => {
    it("extracts versions from freeform text", () => {
      const body = "I'm running minion_hub v.g89sf78 and minion-ai v2026.4.19-4 and it crashes";
      const result = parseVersions(body, repoMap);
      expect(result).toEqual([
        { serviceName: "minion_hub", version: "v.g89sf78", repo: "openclaw/minion_hub" },
        { serviceName: "minion-ai", version: "v2026.4.19-4", repo: "openclaw/minion-ai" },
      ]);
    });

    it("is case-insensitive", () => {
      const body = "Using Minion_Hub v.abc123";
      const result = parseVersions(body, repoMap);
      expect(result).toEqual([
        { serviceName: "minion_hub", version: "v.abc123", repo: "openclaw/minion_hub" },
      ]);
    });
  });

  describe("no versions", () => {
    it("returns empty array when no versions found", () => {
      const body = "Something is broken but I don't know which version";
      const result = parseVersions(body, repoMap);
      expect(result).toEqual([]);
    });

    it("returns empty array for empty body", () => {
      const result = parseVersions("", repoMap);
      expect(result).toEqual([]);
    });
  });
});
