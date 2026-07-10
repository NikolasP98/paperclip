import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoSandboxService, resolveRepoSandboxConfig } from "./repo-sandbox.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const tmp = mkdtempSync(path.join(tmpdir(), "repo-sandbox-"));
const originDir = path.join(tmp, "origin.git");
const seedDir = path.join(tmp, "seed");
const sandboxRoot = path.join(tmp, "sandbox");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("resolveRepoSandboxConfig", () => {
  it("returns null when env vars are missing", () => {
    expect(resolveRepoSandboxConfig({})).toBeNull();
  });

  it("parses REPO_SANDBOX_REPOS json", () => {
    const cfg = resolveRepoSandboxConfig({
      REPO_SANDBOX_DIR: "/x",
      REPO_SANDBOX_REPOS: '[{"name":"a","gitUrl":"https://github.com/o/a.git","defaultBranch":"main"}]',
    });
    expect(cfg).toEqual({
      rootDir: "/x",
      repos: [{ name: "a", gitUrl: "https://github.com/o/a.git", defaultBranch: "main" }],
    });
  });
});

describe("repoSandboxService", () => {
  it("clones missing repos, then refresh picks up new upstream commits", async () => {
    // fixture: bare origin + a seed clone that pushes commits to it
    execFileSync("git", ["init", "--bare", "-b", "main", originDir]);
    execFileSync("git", ["clone", originDir, seedDir]);
    git(["config", "user.email", "t@t"], seedDir);
    git(["config", "user.name", "t"], seedDir);
    writeFileSync(path.join(seedDir, "a.txt"), "one");
    git(["add", "."], seedDir);
    git(["commit", "-m", "c1"], seedDir);
    git(["push", "origin", "main"], seedDir);

    const svc = repoSandboxService({
      rootDir: sandboxRoot,
      repos: [{ name: "fixture", gitUrl: originDir, defaultBranch: "main" }],
    });
    await svc.ensureClones();
    const cloneDir = svc.repoDir("fixture");
    const before = git(["rev-parse", "origin/main"], cloneDir);

    writeFileSync(path.join(seedDir, "a.txt"), "two");
    git(["add", "."], seedDir);
    git(["commit", "-m", "c2"], seedDir);
    git(["push", "origin", "main"], seedDir);

    await svc.refresh("fixture");
    const after = git(["rev-parse", "origin/main"], cloneDir);
    expect(after).not.toBe(before);
    expect(after).toBe(git(["rev-parse", "main"], seedDir));
  });

  it("maps a github full_name to a registry entry", () => {
    const svc = repoSandboxService({
      rootDir: "/x",
      repos: [{ name: "minion_hub", gitUrl: "https://github.com/NikolasP98/minion_hub.git", defaultBranch: "dev" }],
    });
    expect(svc.findByCloneUrlRepo("NikolasP98/minion_hub")?.name).toBe("minion_hub");
    expect(svc.findByCloneUrlRepo("NikolasP98/other")).toBeNull();
  });

  it("refresh on unknown repo rejects", async () => {
    const svc = repoSandboxService({ rootDir: "/x", repos: [] });
    await expect(svc.refresh("nope")).rejects.toThrow(/unknown repo/i);
  });
});
