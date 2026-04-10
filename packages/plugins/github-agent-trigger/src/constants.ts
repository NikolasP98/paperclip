export const PLUGIN_ID = "openclaw.github-agent-trigger";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  githubEvents: "github-events",
} as const;

export const TOOL_NAMES = {
  githubComment: "github-comment",
  githubClose: "github-close",
  githubStatus: "github-status",
} as const;

export const STATE_PREFIXES = {
  github: "gh:",
  paperclip: "pc:",
} as const;

export const DEFAULTS = {
  triggerLabel: "agent",
  mentionKeyword: "@paperclip",
} as const;

export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_API_BASE = "https://api.github.com";

export type IssueStatus = "awaiting-versions" | "investigating" | "resolved" | "closed";

export interface ServiceVersion {
  serviceName: string;
  version: string;
  repo: string;
}

export interface GithubLink {
  paperclipIssueId: string | null;
  status: IssueStatus;
  versions: ServiceVersion[];
  createdAt: string;
}

export interface PaperclipLink {
  ghOwner: string;
  ghRepo: string;
  ghNumber: number;
  ghUrl: string;
}

export interface PluginConfig {
  githubTokenRef: string;
  webhookSecret: string;
  companyId: string;
  defaultAgentId: string;
  repoMap: Record<string, string>;
  triggerLabel: string;
  mentionKeyword: string;
}
