/**
 * Regression test for the CRITICAL mount-order defect fixed alongside this
 * file: githubBugRoutes used to be mounted *inside* the `api` Router, which
 * sits behind `app.use("/api", hubIdentityMiddleware(...))` whenever
 * HUB_PAPERCLIP_SHARED_SECRET is set (the forced posture when DISABLE_UI=1).
 * GitHub sends no x-hub-identity JWT — it authenticates via HMAC
 * (X-Hub-Signature-256) inside the route handler — so every real delivery
 * was 401ing before the HMAC check ever ran.
 *
 * This drives the *actual* mounted app (via createApp), with the real
 * hubIdentityMiddleware and the real github-bugs route both active, to prove:
 *   1. A validly-HMAC-signed webhook POST reaches the handler with no
 *      x-hub-identity header (does not get the guard's 401).
 *   2. Every other /api route is still gated by the guard as before.
 *
 * Mocking strategy mirrors app-disable-ui.test.ts (see that file for the
 * "why" of each mock): stub out the heavy plugin subsystem and route
 * factories that would otherwise touch the DB or filesystem, but — unlike
 * that file — leave `../middleware/hub-identity.js` and
 * `../routes/github-bugs.js` unmocked, since those are exactly what this
 * test exercises.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Heavy module mocks — must be declared before any imports from app.ts
// ---------------------------------------------------------------------------
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../services/plugin-loader.js", () => ({
  DEFAULT_LOCAL_PLUGIN_DIR: "/tmp/test-plugins",
  pluginLoader: vi.fn(() => ({
    loadAll: vi.fn(async () => null),
  })),
}));

vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: vi.fn(() => ({
    getWorker: vi.fn(() => null),
  })),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: vi.fn(() => ({
    getById: vi.fn(async () => null),
  })),
}));

vi.mock("../services/plugin-event-bus.js", () => ({
  createPluginEventBus: vi.fn(() => ({})),
}));

vi.mock("../services/activity-log.js", () => ({
  setPluginEventBus: vi.fn(),
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/plugin-job-store.js", () => ({
  pluginJobStore: vi.fn(() => ({})),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: vi.fn(() => ({
    onWorkerExit: vi.fn(),
  })),
}));

vi.mock("../services/plugin-job-scheduler.js", () => ({
  createPluginJobScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../services/plugin-tool-dispatcher.js", () => ({
  createPluginToolDispatcher: vi.fn(() => ({
    initialize: vi.fn(async () => undefined),
  })),
}));

vi.mock("../services/plugin-job-coordinator.js", () => ({
  createPluginJobCoordinator: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../services/plugin-host-services.js", () => ({
  buildHostServices: vi.fn(() => ({ dispose: vi.fn() })),
  flushPluginLogBuffer: vi.fn(async () => undefined),
}));

vi.mock("../services/plugin-host-service-cleanup.js", () => ({
  createPluginHostServiceCleanup: vi.fn(() => ({
    disposeAll: vi.fn(),
    teardown: vi.fn(),
  })),
}));

vi.mock("../services/plugin-dev-watcher.js", () => ({
  createPluginDevWatcher: vi.fn(() => ({ watch: vi.fn(), close: vi.fn() })),
}));

vi.mock("@paperclipai/plugin-sdk", () => ({
  createHostClientHandlers: vi.fn(() => ({})),
}));

// Mock middleware that reads from DB or files. Deliberately NOT mocking
// ../middleware/hub-identity.js — the guard under test must be real.
vi.mock("../middleware/index.js", () => ({
  httpLogger: (_req: unknown, _res: unknown, next: () => void) => next(),
  errorHandler: (
    err: Error,
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => void } },
    _next: unknown,
  ) => {
    res.status(500).json({ error: err.message });
  },
}));

vi.mock("../middleware/auth.js", () => ({
  actorMiddleware: vi.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

vi.mock("../middleware/board-mutation-guard.js", () => ({
  boardMutationGuard: vi.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

vi.mock("../middleware/private-hostname-guard.js", () => ({
  privateHostnameGuard: vi.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
  resolvePrivateHostnameAllowSet: vi.fn(() => new Set<string>()),
}));

// Mock all route factories so they don't touch the DB. Deliberately NOT
// mocking ../routes/github-bugs.js — the route under test must be real.
vi.mock("../routes/health.js", () => ({ healthRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/companies.js", () => ({ companyRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/company-skills.js", () => ({ companySkillRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/agents.js", () => ({ agentRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/projects.js", () => ({ projectRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/issues.js", () => ({ issueRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/routines.js", () => ({ routineRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/execution-workspaces.js", () => ({ executionWorkspaceRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/goals.js", () => ({ goalRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/approvals.js", () => ({ approvalRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/secrets.js", () => ({ secretRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/costs.js", () => ({ costRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/activity.js", () => ({ activityRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/dashboard.js", () => ({ dashboardRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/sidebar-badges.js", () => ({ sidebarBadgeRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/inbox-dismissals.js", () => ({ inboxDismissalRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/instance-settings.js", () => ({ instanceSettingsRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/llms.js", () => ({ llmRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/assets.js", () => ({ assetRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/access.js", () => ({ accessRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/plugins.js", () => ({ pluginRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/adapters.js", () => ({ adapterRoutes: () => { const { Router } = require("express"); return Router(); } }));
vi.mock("../routes/plugin-ui-static.js", () => ({ pluginUiStaticRoutes: () => { const { Router } = require("express"); return Router(); } }));

import type { Db } from "@paperclipai/db";
import { createApp } from "../app.ts";

const MINIMAL_OPTS = {
  serverPort: 3100,
  storageService: {} as never,
  deploymentMode: "local" as const,
  deploymentExposure: "private" as const,
  allowedHostnames: [],
  bindHost: "127.0.0.1",
  authReady: true,
  companyDeletionEnabled: false,
} satisfies Omit<Parameters<typeof createApp>[1], "uiMode">;

// handleGithubEvent never reaches the DB for an unmatched "ping" event, so a
// bare stub is enough — no query methods need to be implemented.
const MINIMAL_DB = {} as unknown as Db;

const HUB_SECRET = "a".repeat(43) + "="; // base64, matches hub-identity.test.ts fixture
const GITHUB_WEBHOOK_SECRET = "gh-webhook-secret";

const ENV_KEYS = [
  "HUB_PAPERCLIP_SHARED_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_BUGS_COMPANY_ID",
  "GITHUB_BUGS_AGENT_ID",
  "GITHUB_BUG_REPO",
] as const;

function setGithubBugsEnv() {
  process.env.HUB_PAPERCLIP_SHARED_SECRET = HUB_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_BUGS_COMPANY_ID = "company-1";
  process.env.GITHUB_BUGS_AGENT_ID = "agent-1";
  process.env.GITHUB_BUG_REPO = "NikolasP98/minion_hub";
}

describe("githubBugRoutes mount order (hoisted above hubIdentityMiddleware)", () => {
  beforeEach(() => {
    vi.resetModules();
    setGithubBugsEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("reaches the webhook handler for a valid HMAC signature with NO x-hub-identity header", async () => {
    const app = await createApp(MINIMAL_DB, { ...MINIMAL_OPTS, uiMode: "static" });
    const rawBody = JSON.stringify({ zen: "hi" });
    const signature =
      "sha256=" + createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(rawBody).digest("hex");

    const res = await request(app)
      .post("/api/github-bugs/webhook")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature)
      .set("X-GitHub-Event", "ping")
      .send(rawBody);

    // Must NOT be caught by the hub-identity guard.
    expect(res.status).not.toBe(401);
    expect(res.body).not.toMatchObject({ error: "missing_hub_identity" });
    // "ping" is an unmatched event for handleGithubEvent — a clean
    // "ignored" outcome proves the real handler ran.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "ignored" });
  });

  it("still 401s a different /api route with no x-hub-identity header (guard intact)", async () => {
    const app = await createApp(MINIMAL_DB, { ...MINIMAL_OPTS, uiMode: "static" });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "missing_hub_identity" });
  });
});
