import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoSandboxEntry {
  name: string;
  gitUrl: string;
  defaultBranch: string;
}

export interface RepoSandboxConfig {
  rootDir: string;
  repos: RepoSandboxEntry[];
}

export interface RepoSandboxService {
  ensureClones(): Promise<void>;
  refresh(name: string): Promise<void>;
  findByCloneUrlRepo(fullName: string): RepoSandboxEntry | null;
  repoDir(name: string): string;
}

export function resolveRepoSandboxConfig(
  env: Record<string, string | undefined> = process.env,
): RepoSandboxConfig | null {
  const rootDir = env.REPO_SANDBOX_DIR?.trim();
  const reposJson = env.REPO_SANDBOX_REPOS?.trim();
  if (!rootDir || !reposJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reposJson);
  } catch {
    throw new Error("REPO_SANDBOX_REPOS is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("REPO_SANDBOX_REPOS must be a JSON array");
  const repos = parsed.map((r) => {
    const entry = r as Partial<RepoSandboxEntry>;
    if (!entry || typeof entry !== "object" || !entry.name || !entry.gitUrl || !entry.defaultBranch) {
      throw new Error("REPO_SANDBOX_REPOS entries need name, gitUrl, defaultBranch");
    }
    return { name: entry.name, gitUrl: entry.gitUrl, defaultBranch: entry.defaultBranch };
  });
  return { rootDir, repos };
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 120_000 });
}

export function repoSandboxService(config: RepoSandboxConfig): RepoSandboxService {
  const inflight = new Map<string, Promise<void>>();
  const repoDir = (name: string) => path.join(config.rootDir, name);

  const ensureClones = async () => {
    await mkdir(config.rootDir, { recursive: true });
    for (const repo of config.repos) {
      const dir = repoDir(repo.name);
      if (existsSync(path.join(dir, ".git"))) continue;
      // regular clone: resolveGitOwnerRepoRoot needs a working tree (bare repos fail --show-toplevel)
      await runGit(["clone", repo.gitUrl, dir], config.rootDir);
    }
  };

  const refresh = (name: string): Promise<void> => {
    const repo = config.repos.find((r) => r.name === name);
    if (!repo) return Promise.reject(new Error(`unknown repo: ${name}`));
    const existing = inflight.get(name);
    if (existing) return existing; // ponytail: coalesce concurrent refreshes, no queue
    const run = runGit(["fetch", "--prune", "origin"], repoDir(name)).finally(() => {
      inflight.delete(name);
    });
    inflight.set(name, run);
    return run;
  };

  const findByCloneUrlRepo = (fullName: string): RepoSandboxEntry | null => {
    const needle = fullName.toLowerCase();
    return (
      config.repos.find((r) => {
        const url = r.gitUrl.toLowerCase().replace(/\.git$/, "");
        return url.endsWith(`/${needle}`) || url.endsWith(`:${needle}`);
      }) ?? null
    );
  };

  return { ensureClones, refresh, findByCloneUrlRepo, repoDir };
}

let singleton: RepoSandboxService | null | undefined;

/** Lazy env-configured singleton; null when REPO_SANDBOX_* env is absent. */
export function getRepoSandbox(): RepoSandboxService | null {
  if (singleton === undefined) {
    const config = resolveRepoSandboxConfig();
    singleton = config ? repoSandboxService(config) : null;
  }
  return singleton;
}
