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
