import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  DEFAULTS,
  STATE_PREFIXES,
  TOOL_NAMES,
  WEBHOOK_KEYS,
  type GithubLink,
  type PluginConfig,
  type PaperclipLink,
} from "./constants.js";
import { verifySignature, postComment, closeIssue, getIssue, getIssueComments } from "./github.js";
import { parseVersions } from "./version-parser.js";
import { buildInvestigationPrompt, buildFollowUpPrompt } from "./prompt.js";

async function getConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = await ctx.config.get();
  return {
    githubTokenRef: raw.githubTokenRef as string,
    webhookSecret: raw.webhookSecret as string,
    companyId: raw.companyId as string,
    defaultAgentId: raw.defaultAgentId as string,
    repoMap: (raw.repoMap as Record<string, string>) ?? {},
    triggerLabel: (raw.triggerLabel as string) || DEFAULTS.triggerLabel,
    mentionKeyword: (raw.mentionKeyword as string) || DEFAULTS.mentionKeyword,
  };
}

function ghKey(owner: string, repo: string, number: number): string {
  return `${STATE_PREFIXES.github}${owner}/${repo}#${number}`;
}

function pcKey(issueId: string): string {
  return `${STATE_PREFIXES.paperclip}${issueId}`;
}

async function getGhLink(ctx: PluginContext, owner: string, repo: string, number: number): Promise<GithubLink | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: ghKey(owner, repo, number) })) as GithubLink | null;
}

async function getPcLink(ctx: PluginContext, issueId: string): Promise<PaperclipLink | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: pcKey(issueId) })) as PaperclipLink | null;
}

async function saveLinks(ctx: PluginContext, owner: string, repo: string, number: number, gh: GithubLink, pc: PaperclipLink): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: ghKey(owner, repo, number) }, gh);
  await ctx.state.set({ scopeKind: "instance", stateKey: pcKey(gh.paperclipIssueId!) }, pc);
}

function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

async function handleIssueOpened(ctx: PluginContext, config: PluginConfig, payload: Record<string, unknown>): Promise<void> {
  const issue = payload.issue as Record<string, unknown>;
  const repoData = payload.repository as Record<string, unknown>;
  const fullName = repoData.full_name as string;
  const { owner, repo } = splitRepo(fullName);
  const number = issue.number as number;
  const title = issue.title as string;
  const body = (issue.body as string) ?? "";
  const author = (issue.user as Record<string, unknown>).login as string;
  const url = issue.html_url as string;

  const existing = await getGhLink(ctx, owner, repo, number);
  if (existing && existing.status !== "awaiting-versions") {
    ctx.logger.info("Issue already linked, skipping", { owner, repo, number });
    return;
  }

  const versions = parseVersions(body, config.repoMap);

  if (versions.length === 0) {
    const token = await ctx.secrets.resolve(config.githubTokenRef);
    const serviceNames = Object.keys(config.repoMap).join("`, `");
    await postComment(owner, repo, number, [
      "Thanks for reporting this issue. To investigate, I need to know which service versions you're running.",
      "",
      "Please update this issue with a **Services** section:",
      "```",
      "### Services",
      ...Object.keys(config.repoMap).map((s) => `- ${s}: v<version>`),
      "```",
      "",
      `Known services: \`${serviceNames}\``,
    ].join("\n"), token);

    await ctx.state.set(
      { scopeKind: "instance", stateKey: ghKey(owner, repo, number) },
      { paperclipIssueId: null, status: "awaiting-versions", versions: [], createdAt: new Date().toISOString() },
    );
    ctx.logger.info("Requested versions", { owner, repo, number });
    return;
  }

  const pcIssue = await ctx.issues.create({
    companyId: config.companyId,
    title: `[GH#${number}] ${title}`,
    description: `GitHub Issue: ${url}\nAuthor: ${author}\nVersions: ${versions.map((v) => `${v.serviceName} ${v.version}`).join(", ")}`,
    assigneeAgentId: config.defaultAgentId,
  });

  await saveLinks(ctx, owner, repo, number, {
    paperclipIssueId: pcIssue.id,
    status: "investigating",
    versions,
    createdAt: new Date().toISOString(),
  }, { ghOwner: owner, ghRepo: repo, ghNumber: number, ghUrl: url });

  const prompt = buildInvestigationPrompt({ number, title, author, url, body, repo: fullName, versions });
  const result = await ctx.agents.invoke(config.defaultAgentId, config.companyId, { prompt, reason: "github-issue-opened" });

  await ctx.activity.log({
    companyId: config.companyId,
    message: `GitHub issue #${number} from ${fullName} triggered agent investigation`,
    entityType: "issue",
    entityId: pcIssue.id,
    metadata: { runId: result.runId, ghUrl: url },
  });
  ctx.logger.info("Agent invoked for issue", { number, runId: result.runId });
}

async function handleIssueLabeled(ctx: PluginContext, config: PluginConfig, payload: Record<string, unknown>): Promise<void> {
  const label = payload.label as Record<string, unknown>;
  if ((label.name as string).toLowerCase() !== config.triggerLabel.toLowerCase()) return;
  await handleIssueOpened(ctx, config, payload);
}

async function handleComment(ctx: PluginContext, config: PluginConfig, payload: Record<string, unknown>): Promise<void> {
  const comment = payload.comment as Record<string, unknown>;
  const commentBody = comment.body as string;
  if (!commentBody.toLowerCase().includes(config.mentionKeyword.toLowerCase())) return;

  const issue = payload.issue as Record<string, unknown>;
  const repoData = payload.repository as Record<string, unknown>;
  const { owner, repo } = splitRepo(repoData.full_name as string);
  const number = issue.number as number;

  const link = await getGhLink(ctx, owner, repo, number);

  if (!link || !link.paperclipIssueId) {
    await handleIssueOpened(ctx, config, payload);
    return;
  }

  const prompt = buildFollowUpPrompt({
    number,
    commentAuthor: (comment.user as Record<string, unknown>).login as string,
    commentBody,
    paperclipIssueId: link.paperclipIssueId,
  });
  const result = await ctx.agents.invoke(config.defaultAgentId, config.companyId, { prompt, reason: "github-comment-mention" });
  ctx.logger.info("Agent re-invoked via comment", { number, runId: result.runId });
}

let workerCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    workerCtx = ctx;
    ctx.logger.info("GitHub Agent Trigger plugin starting");
    const config = await getConfig(ctx);

    // Tool: github-comment
    ctx.tools.register(TOOL_NAMES.githubComment, {
      displayName: "Comment on GitHub Issue",
      description: "Post a comment on the linked GitHub issue",
      parametersSchema: { type: "object", properties: { issueId: { type: "string" }, body: { type: "string" } }, required: ["issueId", "body"] },
    }, async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
      const { issueId, body } = params as { issueId: string; body: string };
      const link = await getPcLink(ctx, issueId);
      if (!link) return { error: "No GitHub issue linked to this Paperclip issue" };
      const token = await ctx.secrets.resolve(config.githubTokenRef);
      await postComment(link.ghOwner, link.ghRepo, link.ghNumber, body, token);
      return { content: `Comment posted on ${link.ghOwner}/${link.ghRepo}#${link.ghNumber}` };
    });

    // Tool: github-close
    ctx.tools.register(TOOL_NAMES.githubClose, {
      displayName: "Close GitHub Issue",
      description: "Close the linked GitHub issue with a comment",
      parametersSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" }, reason: { type: "string", enum: ["completed", "not_planned"] } },
        required: ["issueId", "body", "reason"],
      },
    }, async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
      const { issueId, body, reason } = params as { issueId: string; body: string; reason: "completed" | "not_planned" };
      const link = await getPcLink(ctx, issueId);
      if (!link) return { error: "No GitHub issue linked to this Paperclip issue" };
      const token = await ctx.secrets.resolve(config.githubTokenRef);
      await postComment(link.ghOwner, link.ghRepo, link.ghNumber, body, token);
      await closeIssue(link.ghOwner, link.ghRepo, link.ghNumber, reason, token);
      const ghLink = await getGhLink(ctx, link.ghOwner, link.ghRepo, link.ghNumber);
      if (ghLink) {
        ghLink.status = "closed";
        await ctx.state.set({ scopeKind: "instance", stateKey: ghKey(link.ghOwner, link.ghRepo, link.ghNumber) }, ghLink);
      }
      return { content: `Closed ${link.ghOwner}/${link.ghRepo}#${link.ghNumber} as ${reason}` };
    });

    // Tool: github-status
    ctx.tools.register(TOOL_NAMES.githubStatus, {
      displayName: "Get GitHub Issue Status",
      description: "Get current state and latest comments of the linked GitHub issue",
      parametersSchema: { type: "object", properties: { issueId: { type: "string" } }, required: ["issueId"] },
    }, async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
      const { issueId } = params as { issueId: string };
      const link = await getPcLink(ctx, issueId);
      if (!link) return { error: "No GitHub issue linked to this Paperclip issue" };
      const token = await ctx.secrets.resolve(config.githubTokenRef);
      const [issue, comments] = await Promise.all([
        getIssue(link.ghOwner, link.ghRepo, link.ghNumber, token),
        getIssueComments(link.ghOwner, link.ghRepo, link.ghNumber, token),
      ]);
      return {
        content: `GitHub Issue #${link.ghNumber}: ${issue.title}\nState: ${issue.state}\nURL: ${issue.html_url}`,
        data: {
          state: issue.state, title: issue.title, url: issue.html_url, labels: issue.labels,
          recentComments: comments.slice(0, 5).map((c: Record<string, unknown>) => ({
            author: (c.user as Record<string, unknown>)?.login, body: c.body, createdAt: c.created_at,
          })),
        },
      };
    });

    // Event: Paperclip issue resolved → comment on GitHub
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const payload = event.payload as Record<string, unknown>;
      const issueId = event.entityId;
      if (!issueId) return;
      const status = payload.status as string | undefined;
      if (status !== "done" && status !== "cancelled") return;
      const link = await getPcLink(ctx, issueId);
      if (!link) return;
      const token = await ctx.secrets.resolve(config.githubTokenRef);
      await postComment(link.ghOwner, link.ghRepo, link.ghNumber, `This issue has been resolved in Paperclip. Status: **${status}**`, token);
      const ghLink = await getGhLink(ctx, link.ghOwner, link.ghRepo, link.ghNumber);
      if (ghLink) {
        ghLink.status = "resolved";
        await ctx.state.set({ scopeKind: "instance", stateKey: ghKey(link.ghOwner, link.ghRepo, link.ghNumber) }, ghLink);
      }
      ctx.logger.info("Posted status update to GitHub", { ghNumber: link.ghNumber, status });
    });

    ctx.logger.info("GitHub Agent Trigger plugin ready");
  },

  async onWebhook(input: PluginWebhookInput) {
    if (!workerCtx) return;
    const ctx = workerCtx;
    const config = await getConfig(ctx);

    if (input.endpointKey !== WEBHOOK_KEYS.githubEvents) return;

    const secret = await ctx.secrets.resolve(config.webhookSecret);
    const signature = (input.headers["x-hub-signature-256"] ?? "") as string;
    if (!verifySignature(input.rawBody, signature, secret)) {
      ctx.logger.warn("Invalid webhook signature, rejecting");
      return;
    }

    const event = input.headers["x-github-event"] as string;
    const payload = input.parsedBody as Record<string, unknown>;
    const action = payload.action as string;
    ctx.logger.info("Received GitHub webhook", { event, action });

    if (event === "issues" && action === "opened") {
      await handleIssueOpened(ctx, config, payload);
    } else if (event === "issues" && action === "labeled") {
      await handleIssueLabeled(ctx, config, payload);
    } else if (event === "issue_comment" && action === "created") {
      await handleComment(ctx, config, payload);
    }
  },
});

export default plugin;

runWorker(plugin, import.meta.url);
