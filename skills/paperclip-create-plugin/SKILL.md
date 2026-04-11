---
name: paperclip-create-plugin
description: >
  Create, scaffold, and author Paperclip plugins using the current alpha SDK/runtime.
  Covers architecture, manifest authoring, capability model, UI slots, agent tools,
  events, jobs, webhooks, state storage, testing, and verification. Use when building
  a new plugin, adding features to an existing plugin, or understanding the plugin system.
---

# Create a Paperclip Plugin

Use this skill when the task involves creating, scaffolding, modifying, or documenting a Paperclip plugin.

## 1. Ground rules

Read these when needed (paths relative to repo root):

1. `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` — current alpha surface
2. `packages/plugins/sdk/README.md` — SDK exports and testing
3. `doc/plugins/PLUGIN_SPEC.md` — future-looking context only

Current runtime assumptions:

- Plugin workers are **trusted code** (not sandboxed OS-level)
- Plugin UI is **trusted same-origin** host code (not iframe-sandboxed)
- Worker APIs are **capability-gated** at every call
- No host-provided shared plugin UI component kit yet
- `ctx.assets` is not supported in the current runtime
- Single-tenant, self-hosted, filesystem-persistent deployment model

## 2. Architecture overview

### Process model

```
Host (Paperclip server)
  │
  ├── Plugin Loader      — discovers + installs from npm or local path
  ├── Plugin Registry     — CRUD on plugins table
  ├── Plugin Lifecycle    — state machine (installed → ready → disabled/error)
  ├── Plugin Worker Mgr   — spawns one Node.js subprocess per plugin
  │     └── Worker ←──JSON-RPC over stdio──→ Host Services
  ├── Plugin Event Bus    — routes domain events to subscribed workers
  ├── Plugin Job Scheduler— cron execution
  ├── Plugin Tool Dispatch— agent → tool routing
  └── Plugin UI Server    — serves UI bundles at /_plugins/:id/ui/*
```

- **One worker process per plugin** communicating via JSON-RPC over stdio
- Host enforces capability gates on every `ctx.*` call
- Workers restart automatically on crash or config change
- UI components render as same-origin ES modules in host extension slots

### Plugin definition structure

```
my-plugin/
├── src/
│   ├── manifest.ts      # PaperclipPluginManifestV1 — identity, capabilities, features
│   ├── worker.ts        # definePlugin({ setup(ctx) { ... } }) — server-side logic
│   └── ui/
│       └── index.tsx    # React components for UI slots
├── tests/
│   └── plugin.spec.ts   # Tests using createTestHarness
├── esbuild.config.mjs   # Worker bundler config
├── rollup.config.mjs    # UI bundler config
└── package.json
```

### Lifecycle hooks

```typescript
import { definePlugin } from "@paperclipai/plugin-sdk";

export default definePlugin({
  // REQUIRED — called once when the worker starts
  async setup(ctx: PluginContext): Promise<void> { ... },

  // OPTIONAL — health check for diagnostics dashboard
  async onHealth?(): Promise<PluginHealthDiagnostics> { ... },

  // OPTIONAL — hot config reload (else worker restarts)
  async onConfigChanged?(newConfig: Record<string, unknown>): Promise<void> { ... },

  // OPTIONAL — graceful shutdown (10s deadline)
  async onShutdown?(): Promise<void> { ... },

  // OPTIONAL — validate config before applying
  async onValidateConfig?(config: Record<string, unknown>): Promise<PluginConfigValidationResult> { ... },

  // OPTIONAL — handle inbound webhooks
  async onWebhook?(input: PluginWebhookInput): Promise<void> { ... },
});
```

## 3. Scaffold a plugin

Use the scaffold CLI instead of hand-writing boilerplate:

```bash
# Build the scaffold tool first
pnpm --filter @paperclipai/create-paperclip-plugin build

# Inside the monorepo (uses workspace:* for SDK)
node packages/plugins/create-paperclip-plugin/dist/index.js @scope/plugin-name \
  --output ./packages/plugins/examples

# Outside the monorepo (snapshots SDK into .paperclip-sdk/)
node packages/plugins/create-paperclip-plugin/dist/index.js @scope/plugin-name \
  --output /absolute/path/to/plugin-repos \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
```

Templates: `default`, `connector`, `workspace`. Categories: `connector`, `workspace`, `automation`, `ui`.

## 4. Manifest reference

### Minimal manifest

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "org.my-plugin",                    // lowercase alphanumeric + dots/hyphens/underscores
  apiVersion: 1,                          // must be 1
  version: "1.0.0",                       // semver
  displayName: "My Plugin",              // max 100 chars
  description: "What it does",           // max 500 chars
  author: "Your Name",                   // max 200 chars
  categories: ["automation"],            // connector | workspace | automation | ui
  capabilities: ["events.subscribe"],    // at least one required
  entrypoints: { worker: "./dist/worker.js" },
};
export default manifest;
```

### Full-featured manifest adds

```typescript
{
  // ...minimal fields...
  minimumHostVersion: "1.0.0",           // semver lower bound

  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",                     // required when ui.slots is declared
  },

  instanceConfigSchema: { /* JSON Schema */ },

  jobs: [{ jobKey: "sync", displayName: "Full Sync", schedule: "0 2 * * *" }],

  webhooks: [{ endpointKey: "ingest", displayName: "Event Ingest" }],

  tools: [{
    name: "search",
    displayName: "Search",
    description: "Search external system",
    parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  }],

  ui: {
    slots: [
      { type: "page", id: "dashboard", displayName: "Dashboard", exportName: "DashboardPage", routePath: "my-dashboard" },
      { type: "detailTab", id: "info", displayName: "Info", exportName: "InfoTab", entityTypes: ["project"] },
    ],
    launchers: [{
      id: "quick-action",
      displayName: "Quick Action",
      placementZone: "toolbarButton",
      entityTypes: ["issue"],
      action: { type: "openModal", target: "QuickModal" },
      render: { environment: "hostOverlay", bounds: "wide" },
    }],
  },
}
```

### Validation rules

- ID format: `^[a-z0-9][a-z0-9._-]*$`
- At least one capability required
- `entrypoints.ui` required if `ui.slots` is declared
- Tools require `agent.tools.register` capability
- Jobs require `jobs.schedule` capability
- Webhooks require `webhooks.receive` capability
- No duplicate job keys, tool names, slot IDs, or launcher IDs
- `routePath` only on `page` slots (single lowercase slug, cannot collide with reserved routes)

### Reserved route segments (cannot be used as routePath)

`dashboard`, `onboarding`, `companies`, `company`, `settings`, `plugins`, `org`, `agents`, `projects`, `issues`, `goals`, `approvals`, `costs`, `activity`, `inbox`, `design-guide`, `tests`

## 5. Capabilities reference

Declare only what your plugin needs. Host rejects calls for undeclared capabilities.

### Data Read

| Capability | Unlocks |
|---|---|
| `companies.read` | `ctx.companies.list()`, `.get()` |
| `projects.read` | `ctx.projects.list()`, `.get()` |
| `project.workspaces.read` | `ctx.projects.listWorkspaces()`, `.getPrimaryWorkspace()`, `.getWorkspaceForIssue()` |
| `issues.read` | `ctx.issues.list()`, `.get()` |
| `issue.comments.read` | `ctx.issues.listComments()` |
| `issue.documents.read` | `ctx.issues.documents.list()`, `.get()` |
| `agents.read` | `ctx.agents.list()`, `.get()` |
| `goals.read` | `ctx.goals.list()`, `.get()` |
| `activity.read` | Read activity log entries |
| `costs.read` | Read cost/billing data |

### Data Write

| Capability | Unlocks |
|---|---|
| `issues.create` | `ctx.issues.create()` |
| `issues.update` | `ctx.issues.update()` |
| `issue.comments.create` | `ctx.issues.createComment()` |
| `issue.documents.write` | `ctx.issues.documents.upsert()`, `.delete()` |
| `goals.create` | `ctx.goals.create()` |
| `goals.update` | `ctx.goals.update()` |
| `agents.pause` | `ctx.agents.pause()` |
| `agents.resume` | `ctx.agents.resume()` |
| `agents.invoke` | `ctx.agents.invoke()` |
| `agent.sessions.create` | `ctx.agents.sessions.create()` |
| `agent.sessions.list` | `ctx.agents.sessions.list()` |
| `agent.sessions.send` | `ctx.agents.sessions.sendMessage()` |
| `agent.sessions.close` | `ctx.agents.sessions.close()` |
| `activity.log.write` | `ctx.activity.log()` |
| `metrics.write` | `ctx.metrics.write()` |

### Plugin State

| Capability | Unlocks |
|---|---|
| `plugin.state.read` | `ctx.state.get()` |
| `plugin.state.write` | `ctx.state.set()`, `.delete()` |

### Runtime / Integration

| Capability | Unlocks |
|---|---|
| `events.subscribe` | `ctx.events.on()` |
| `events.emit` | `ctx.events.emit()` — auto-namespaced as `plugin.<pluginId>.<name>` |
| `jobs.schedule` | `ctx.jobs.register()` |
| `webhooks.receive` | `onWebhook()` handler |
| `http.outbound` | `ctx.http.fetch()` |
| `secrets.read-ref` | `ctx.secrets.resolve()` |

### Agent Tools

| Capability | Unlocks |
|---|---|
| `agent.tools.register` | `ctx.tools.register()` |

### UI

| Capability | Unlocks |
|---|---|
| `instance.settings.register` | Settings page slot |
| `ui.sidebar.register` | Sidebar slot |
| `ui.page.register` | Full page slot |
| `ui.detailTab.register` | Detail tab slot |
| `ui.dashboardWidget.register` | Dashboard widget slot |
| `ui.commentAnnotation.register` | Comment annotation slot |
| `ui.action.register` | Action/context menu slot |

## 6. UI slot types

| Slot Type | Entity Types | Props | Notes |
|---|---|---|---|
| `page` | — | `companyId`, `params` | Requires `routePath` (lowercase slug) |
| `settingsPage` | — | `companyId` | Plugin settings |
| `dashboardWidget` | — | `companyId` | Dashboard card |
| `sidebar` | — | `companyId` | Main sidebar entry |
| `sidebarPanel` | — | `companyId` | Sidebar panel |
| `projectSidebarItem` | `project` | `companyId`, `entityId`, `entityType` | Per-project sidebar |
| `detailTab` | `project`, `issue`, `agent`, `goal`, `run`, `comment` | `companyId`, `entityId`, `entityType` | Tab on detail views |
| `taskDetailView` | `issue` | `companyId`, `entityId`, `entityType` | Custom task view |
| `globalToolbarButton` | — | `companyId` | Top toolbar |
| `toolbarButton` | `project`, `issue`, `agent`, `goal`, `run`, `comment` | `companyId`, `entityId`, `entityType` | Entity toolbar |
| `contextMenuItem` | `project`, `issue`, `agent`, `goal`, `run`, `comment` | `companyId`, `entityId`, `entityType` | Right-click menu |
| `commentAnnotation` | `comment` | `companyId`, `entityId`, `entityType` | Inline on comments |
| `commentContextMenuItem` | `comment` | `companyId`, `entityId`, `entityType` | Comment context menu |

### UI hooks (import from `@paperclipai/plugin-sdk/ui`)

```typescript
usePluginData(key, params)    // Fetch data from worker (calls ctx.data handler)
usePluginAction(key, params)  // Trigger action in worker (calls ctx.actions handler)
usePluginStream(channel)      // Subscribe to real-time SSE from worker
usePluginToast(message, type) // Show toast notification
useHostContext()              // Get { companyId, projectId, entityId, ... }
```

## 7. Domain events

Subscribe via `ctx.events.on(eventType, handler)` or with filter: `ctx.events.on(eventType, filter, handler)`.

| Event Type | Payload Entity |
|---|---|
| `company.created`, `company.updated` | Company |
| `project.created`, `project.updated` | Project |
| `project.workspace_created`, `project.workspace_updated`, `project.workspace_deleted` | Workspace |
| `issue.created`, `issue.updated` | Issue |
| `issue.comment.created` | Comment |
| `agent.created`, `agent.updated`, `agent.status_changed` | Agent |
| `agent.run.started`, `agent.run.finished`, `agent.run.failed`, `agent.run.cancelled` | Run |
| `goal.created`, `goal.updated` | Goal |
| `approval.created`, `approval.decided` | Approval |
| `cost_event.created` | Cost Event |
| `activity.logged` | Activity |

Filters: `{ projectId?, companyId?, agentId? }` — evaluated server-side.

Wildcard: `ctx.events.on("plugin.acme.*", handler)` matches all `plugin.acme.X` events.

## 8. State storage

Scoped key-value store with 5-part composite key: `(pluginId, scopeKind, scopeId, namespace, stateKey)`.

| Scope Kind | scopeId | Typical Use |
|---|---|---|
| `instance` | omit | Global flags, schema version, last full-sync |
| `company` | company UUID | Per-company sync cursors |
| `project` | project UUID | Per-project settings |
| `project_workspace` | workspace UUID | Per-workspace state |
| `agent` | agent UUID | Per-agent memory |
| `issue` | issue UUID | Idempotency keys, linked external IDs |
| `goal` | goal UUID | Per-goal progress |
| `run` | run UUID | Per-run checkpoints |

```typescript
// Instance-global
await ctx.state.set({ scopeKind: "instance", stateKey: "schema-version" }, 2);

// Per-issue idempotency
const synced = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, stateKey: "synced" });

// Namespaced per-project
await ctx.state.set({ scopeKind: "project", scopeId: projectId, namespace: "github", stateKey: "cursor" }, cursor);
```

## 9. Common patterns

### Agent tool registration

```typescript
// In manifest:
tools: [{
  name: "clone-repo",
  displayName: "Clone Repository",
  description: "Clone a Git repo into the project workspace",
  parametersSchema: {
    type: "object",
    properties: {
      repoUrl: { type: "string", description: "Git repository URL" },
      branch: { type: "string", description: "Branch to clone" },
    },
    required: ["repoUrl"],
  },
}],

// In worker setup():
ctx.tools.register("clone-repo", {
  displayName: "Clone Repository",
  description: "Clone a Git repo into the project workspace",
  parametersSchema: { /* same as manifest */ },
}, async (params, runCtx) => {
  const { repoUrl, branch } = params as { repoUrl: string; branch?: string };
  const workspace = await ctx.projects.getPrimaryWorkspace(runCtx.projectId, runCtx.companyId);
  if (!workspace) return { error: "No workspace configured" };

  // Tools are namespaced at runtime as "pluginId:clone-repo"
  return { content: `Cloned ${repoUrl} to ${workspace.path}`, data: { path: workspace.path } };
});
```

### Event-driven automation

```typescript
ctx.events.on("issue.created", async (event) => {
  ctx.logger.info("New issue", { issueId: event.entityId });
  await ctx.activity.log({
    companyId: event.companyId,
    message: `Plugin processed new issue`,
    entityType: "issue",
    entityId: event.entityId,
  });
});
```

### Scheduled jobs

```typescript
// In manifest:
jobs: [{ jobKey: "full-sync", displayName: "Full Sync", schedule: "0 2 * * *" }],

// In worker setup():
ctx.jobs.register("full-sync", async (job) => {
  ctx.logger.info(`Running ${job.jobKey}`, { runId: job.runId, trigger: job.trigger });
  // ... sync logic ...
});
```

### Webhook handling

```typescript
// In manifest:
webhooks: [{ endpointKey: "github", displayName: "GitHub Events" }],

// In worker:
async onWebhook(input) {
  const { endpointKey, headers, body } = input;
  if (endpointKey === "github") {
    // Verify HMAC signature from headers
    // Process payload
  }
}
// Route: POST /api/plugins/:pluginId/webhooks/github
```

### Real-time streams to UI

```typescript
// Worker:
ctx.streams.open("progress", companyId);
for (const step of steps) {
  await doWork(step);
  ctx.streams.emit("progress", { step: step.name, percent: step.progress });
}
ctx.streams.close("progress");

// UI component:
const events = usePluginStream("progress");
```

### Secrets resolution

```typescript
// Config stores reference string, not the value
const config = await ctx.config.get();
const apiKey = await ctx.secrets.resolve(config.apiKeyRef as string);
// Never cache or log the resolved value
```

### Workspace filesystem access

```typescript
const workspace = await ctx.projects.getPrimaryWorkspace(projectId, companyId);
if (workspace) {
  // workspace.path is the absolute filesystem path
  // Read/write files, run git commands, etc.
  const files = await fs.readdir(workspace.path);
}
```

## 10. Installation

### Install via API

```bash
# From npm
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName": "paperclip-plugin-foo"}'

# From local path (dev workflow)
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName": "/absolute/path/to/plugin", "isLocalPath": true}'
```

### Plugin API endpoints

```
GET  /api/plugins                              List installed
POST /api/plugins/install                      Install
POST /api/plugins/:id/uninstall                Uninstall
POST /api/plugins/:id/enable                   Enable
POST /api/plugins/:id/disable                  Disable
GET  /api/plugins/:id/health                   Health check
POST /api/plugins/:id/upgrade                  Upgrade
GET  /api/plugins/:id/tools                    List tools
POST /api/plugins/:id/tools/:toolName          Execute tool
POST /api/plugins/:id/webhooks/:endpointKey    Inbound webhook
GET  /api/plugins/:id/ui/slots                 UI contributions
GET  /_plugins/:id/ui/*                        Serve UI bundle
```

Local-path plugins are watched for file changes — worker restarts automatically after rebuilds.

## 11. Available community plugins

These are installable from the Plugin Manager UI or via npm:

### Official (by paperclipai/mvanhorn)

| Package | Description |
|---|---|
| `paperclip-plugin-telegram` | Bidirectional Telegram bot |
| `paperclip-plugin-discord` | Bidirectional Discord |
| `paperclip-plugin-slack` | Slack notifications |
| `paperclip-plugin-acp` | ACP (Agent Client Protocol) runtime |
| `paperclip-plugin-github-issues` | Bidirectional GitHub Issues sync |

### Community

| Package | Description |
|---|---|
| `@yesterday-ai/paperclip-plugin-company-wizard` | AI wizard to bootstrap agent companies |
| `@lucitra/paperclip-plugin-linear` | Bidirectional Linear issue sync |
| `@tomismeta/paperclip-aperture` | Human-in-the-loop approvals |
| `@lucitra/paperclip-plugin-chat` | Multi-adapter AI chat |
| `@lucitra/paperclip-plugin-updater` | One-click plugin update checker |
| `@lucitra/paperclip-plugin-secrets` | Secret management from Settings UI |
| `paperclip-theme` | In-app theme customizer |
| `paperclip-plugin-claude-config-editor` | Edit Claude Code config from UI |

### Bundled examples (in repo)

| Directory | What it demonstrates |
|---|---|
| `packages/plugins/examples/plugin-hello-world-example` | Minimal UI plugin |
| `packages/plugins/examples/plugin-kitchen-sink-example` | Full API surface |
| `packages/plugins/examples/plugin-file-browser-example` | Project file browser |

## 12. After scaffolding checklist

Check and adjust:

- `src/manifest.ts` — correct ID, only supported capabilities, no `ctx.assets` usage
- `src/worker.ts` — `definePlugin` with `setup(ctx)`, register handlers
- `src/ui/index.tsx` — self-contained components (no host UI component imports)
- `tests/plugin.spec.ts` — uses `createTestHarness` from SDK
- `package.json` — correct dependencies

Ensure:

- Only declares capabilities the plugin actually uses
- Does not import host UI component stubs
- Keeps UI self-contained (bring your own React components)
- Uses `routePath` only on `page` slots
- `routePath` is a single lowercase slug not in the reserved list
- Is installed from absolute local path during development

## 13. If the plugin should appear as bundled example

Update:

- Bundled example list in `server/src/routes/plugins.ts`
- Any docs listing in-repo examples

Only do this if the user explicitly wants it surfaced as a bundled example.

## 14. Publishing guidance

- Use **npm packages** as the deployment artifact for production
- Treat repo-local example installs as development-only
- Keep plugin UI self-contained inside the package
- Do not rely on host design-system components or undocumented app internals
- For local dev: use checked-out local path install
- For production: publish to npm or a private npm-compatible registry

## 15. Verification

Always run before handoff:

```bash
pnpm --filter <plugin-package> typecheck
pnpm --filter <plugin-package> test
pnpm --filter <plugin-package> build
```

If you changed SDK/host/plugin runtime code too:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

## 16. CLI reference

### `paperclipai plugin` — Plugin management

```bash
paperclipai plugin list [--status ready|error|disabled|installed] [--json]
paperclipai plugin install <package> [--local] [--version <ver>]
paperclipai plugin uninstall <pluginKey> [--force]
paperclipai plugin enable <pluginKey>
paperclipai plugin disable <pluginKey>
paperclipai plugin inspect <pluginKey> [--json]
paperclipai plugin examples [--json]
```

**Install examples:**
```bash
# From npm
paperclipai plugin install paperclip-plugin-telegram
paperclipai plugin install @lucitra/paperclip-plugin-linear

# Pinned version
paperclipai plugin install @acme/plugin-linear --version 1.2.0

# From local path (auto-detected for ./, ../, /, ~ prefixes)
paperclipai plugin install ./my-plugin
paperclipai plugin install /absolute/path/to/plugin --local
```

All subcommands accept: `--api-base <url>`, `--api-key <token>`, `--config <path>`, `--data-dir <path>`, `--json`.

### `create-paperclip-plugin` — Scaffold new plugin

```bash
npx @paperclipai/create-paperclip-plugin <name> [options]
```

| Option | Default | Description |
|---|---|---|
| `--template <t>` | `default` | `default`, `connector`, `workspace` |
| `--category <c>` | from template | `connector`, `workspace`, `automation`, `ui` |
| `--display-name <n>` | auto-generated | Human-readable name |
| `--description <d>` | "A Paperclip plugin" | Plugin description |
| `--author <a>` | "Plugin Author" | Author name |
| `--output <dir>` | cwd | Output root directory |
| `--sdk-path <path>` | auto-detect | Local SDK path (monorepo dev) |

**Examples:**
```bash
# Basic
npx @paperclipai/create-paperclip-plugin my-plugin

# Connector with options
npx @paperclipai/create-paperclip-plugin @acme/plugin-linear \
  --template connector --author "Acme Inc" --output ./plugins

# Monorepo dev (inside paperclip repo)
node packages/plugins/create-paperclip-plugin/dist/index.js my-plugin \
  --output ./packages/plugins/examples \
  --sdk-path ./packages/plugins/sdk
```

### `paperclip-plugin-dev-server` — UI hot-reload

Shipped with `@paperclipai/plugin-sdk`. Serves plugin UI bundle with SSE hot-reload.

```bash
paperclip-plugin-dev-server [--root .] [--ui-dir dist/ui] [--host 127.0.0.1] [--port 4177]
```

### Plugin dev workflow scripts

After scaffolding, the generated `package.json` includes:

```bash
pnpm dev          # Watch build (esbuild)
pnpm dev:ui       # UI dev server with hot-reload (port 4177)
pnpm build        # Production build
pnpm test         # Run tests (vitest)
pnpm typecheck    # Type check (tsc --noEmit)
```

## 17. SDK exports reference

| Import Path | Exports |
|---|---|
| `@paperclipai/plugin-sdk` | `definePlugin`, `runWorker`, all TypeScript types |
| `@paperclipai/plugin-sdk/ui` | `usePluginData`, `usePluginAction`, `usePluginStream`, `usePluginToast`, `useHostContext` |
| `@paperclipai/plugin-sdk/testing` | `createTestHarness` |
| `@paperclipai/plugin-sdk/bundlers` | esbuild/rollup presets |
| `@paperclipai/plugin-sdk/dev-server` | Static UI server + SSE hot-reload |
