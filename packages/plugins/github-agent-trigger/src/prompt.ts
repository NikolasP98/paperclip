import type { ServiceVersion } from "./constants.js";

interface InvestigationInput {
  number: number;
  title: string;
  author: string;
  url: string;
  body: string;
  repo: string;
  versions: ServiceVersion[];
}

export function buildInvestigationPrompt(input: InvestigationInput): string {
  const versionLines = input.versions
    .map((v) => `- ${v.serviceName}: ${v.version} (repo: ${v.repo})`)
    .join("\n");

  return `GitHub Issue #${input.number} from ${input.repo} requires investigation.

## Issue
Title: ${input.title}
Author: ${input.author}
URL: ${input.url}

## Services & Versions
${versionLines}

## Issue Body
${input.body}

## Instructions
1. Clone/checkout each listed service at the specified version
2. Investigate the reported issue
3. Determine: is this already fixed in a newer version, or is it a real bug?
4. If already fixed: use the github-comment tool to comment with the version that fixes it
5. If real bug: implement a fix, open a PR, and use github-comment to link the PR on the issue
6. If more context is needed: use github-comment to request clarification`;
}

interface FollowUpInput {
  number: number;
  commentAuthor: string;
  commentBody: string;
  paperclipIssueId: string;
}

export function buildFollowUpPrompt(input: FollowUpInput): string {
  return `Follow-up on GitHub Issue #${input.number}.

New comment from ${input.commentAuthor}:
${input.commentBody}

Previous context: Paperclip issue ${input.paperclipIssueId}`;
}

interface PrReviewInput {
  repo: string;
  number: number;
  prUrl: string;
  prTitle: string;
  prAuthor: string;
  prBody: string;
  diffUrl: string;
  baseBranch: string | undefined;
  commentAuthor: string;
  commentBody: string;
}

export function buildPrReviewPrompt(input: PrReviewInput): string {
  return `GitHub Pull Request review request — ${input.repo}#${input.number}.

## Pull Request
Title: ${input.prTitle}
Author: ${input.prAuthor}
URL: ${input.prUrl}
Diff: ${input.diffUrl}
${input.baseBranch ? `Base: ${input.baseBranch}` : ""}

## PR Description
${input.prBody}

## Review request from ${input.commentAuthor}
${input.commentBody}

## Instructions
1. Fetch the PR diff (${input.diffUrl}) and read the changed files.
2. Address the reviewer's request directly — implement requested changes, answer questions, or push back with reasoning.
3. If code changes are required: clone ${input.repo}, check out the PR branch, make the changes, and force-push to the PR branch.
4. Use the github-comment tool to post a reply summarizing what you did or asking for clarification if blocked.
5. Do NOT close the PR unless explicitly asked.`;
}
