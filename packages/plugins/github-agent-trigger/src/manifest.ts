import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULTS, PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub Agent Trigger",
  description:
    "Receives GitHub issue webhooks, validates service versions, creates Paperclip issues, and invokes the CTO agent to investigate.",
  author: "OpenClaw",
  categories: ["automation"],
  capabilities: [
    "issues.create",
    "issues.update",
    "issues.read",
    "agents.invoke",
    "events.subscribe",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "agent.tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      githubTokenRef: { type: "string", title: "GitHub Token (Secret Ref)", description: "Secret reference for a GitHub PAT with repo scope" },
      webhookSecret: { type: "string", title: "Webhook Secret (Secret Ref)", description: "Secret reference for the HMAC-SHA256 webhook secret" },
      companyId: { type: "string", title: "Company ID", description: "UUID of the MINION company" },
      defaultAgentId: { type: "string", title: "Default Agent ID", description: "UUID of the CTO agent that handles all issues" },
      repoMap: { type: "object", title: "Service to Repo Map", description: "Maps service names to GitHub repos", additionalProperties: { type: "string" } },
      triggerLabel: { type: "string", title: "Trigger Label", default: DEFAULTS.triggerLabel },
      mentionKeyword: { type: "string", title: "Mention Keyword", default: DEFAULTS.mentionKeyword },
    },
    required: ["githubTokenRef", "webhookSecret", "companyId", "defaultAgentId", "repoMap"],
  },
  webhooks: [
    { endpointKey: WEBHOOK_KEYS.githubEvents, displayName: "GitHub Events", description: "Receives GitHub issue and issue_comment webhook events" },
  ],
  tools: [
    {
      name: TOOL_NAMES.githubComment,
      displayName: "Comment on GitHub Issue",
      description: "Post a comment on the linked GitHub issue. Use this to share findings, request clarification, or link PRs.",
      parametersSchema: { type: "object", properties: { issueId: { type: "string" }, body: { type: "string" } }, required: ["issueId", "body"] },
    },
    {
      name: TOOL_NAMES.githubClose,
      displayName: "Close GitHub Issue",
      description: "Close the linked GitHub issue with a comment explaining the resolution.",
      parametersSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" }, reason: { type: "string", enum: ["completed", "not_planned"] } },
        required: ["issueId", "body", "reason"],
      },
    },
    {
      name: TOOL_NAMES.githubStatus,
      displayName: "Get GitHub Issue Status",
      description: "Get the current state, title, and latest comments of the linked GitHub issue.",
      parametersSchema: { type: "object", properties: { issueId: { type: "string" } }, required: ["issueId"] },
    },
  ],
};

export default manifest;
