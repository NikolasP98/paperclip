import { createHmac, timingSafeEqual } from "node:crypto";
import { GITHUB_API_BASE, GITHUB_API_VERSION } from "./constants.js";

export function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = signature.slice("sha256=".length);
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

interface GitHubRequestOpts {
  method?: string;
  body?: unknown;
  token: string;
}

async function githubFetch(path: string, opts: GitHubRequestOpts): Promise<Response> {
  const url = `${GITHUB_API_BASE}${path}`;
  return fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

export async function getIssue(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<Record<string, unknown>> {
  const res = await githubFetch(`/repos/${owner}/${repo}/issues/${number}`, { token });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function postComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
  token: string,
): Promise<void> {
  const res = await githubFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: { body },
    token,
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
}

export async function closeIssue(
  owner: string,
  repo: string,
  number: number,
  reason: "completed" | "not_planned",
  token: string,
): Promise<void> {
  const res = await githubFetch(`/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    body: { state: "closed", state_reason: reason },
    token,
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
}

export async function getIssueComments(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/issues/${number}/comments?per_page=10&sort=created&direction=desc`,
    { token },
  );
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}
