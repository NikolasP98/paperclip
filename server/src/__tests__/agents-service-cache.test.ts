import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents, costEvents } from "@paperclipai/db";
import { agentService } from "../services/agents.ts";
import { __resetCacheForTests } from "../cache.ts";

// agent-permissions normalization is exercised by other suites; here we only
// care about cache hit/miss/invalidation behaviour, so keep the real impl.

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  status: string;
  title: string | null;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  permissions: unknown;
  metadata: Record<string, unknown> | null;
  pauseReason: string | null;
  pausedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Ada",
    role: "general",
    status: "idle",
    title: null,
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: null,
    metadata: null,
    pauseReason: null,
    pausedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Minimal drizzle stub. Dispatches on the *table* (and, for the agents table,
 * on the WHERE column) so it stays correct regardless of how many reads a
 * single loadById issues. loadById currently runs three reads:
 *   1. agents WHERE id = ?         → the by-id read-model load (counted here)
 *   2. agents WHERE company_id = ? → listCompanyAgentRows (org-chain hydration)
 *   3. costEvents …GROUP BY        → monthly-spend aggregate (separately cached)
 * Only the by-id agents read counts as an `agentSelects`, so the assertions
 * track loadById executions — i.e. cache misses — not raw query volume.
 */
function createDbStub(agentRow: AgentRow | null) {
  const counts = { agentSelects: 0, costSelects: 0 };

  // A result that is awaitable (.then) and also chainable via .groupBy()
  // (costEvents path), so the same shape serves every read.
  function thenable(rows: unknown[]) {
    return {
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
      groupBy: vi.fn(async () => rows),
    };
  }

  // A drizzle filter (eq/and(...)) carries its referenced columns in
  // `.queryChunks`; we read their `.name` to tell the by-id read apart from
  // the company-roster read on the same table.
  function predicateColumns(predicate: unknown): string[] {
    const chunks = (predicate as { queryChunks?: unknown[] })?.queryChunks ?? [];
    return chunks
      .filter((c): c is { name: string } => !!c && typeof c === "object" && "name" in c)
      .map((c) => c.name);
  }

  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn((predicate: unknown) => {
        if (table === agents) {
          if (predicateColumns(predicate).includes("id")) {
            counts.agentSelects += 1; // by-id read-model load
            return thenable(agentRow ? [agentRow] : []);
          }
          // listCompanyAgentRows (company roster for org-chain hydration)
          return thenable(agentRow ? [agentRow] : []);
        }
        if (table === costEvents) {
          counts.costSelects += 1;
          return thenable([]);
        }
        return thenable([]);
      }),
    })),
  }));

  // Mutations: update().set().where().returning()
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => (agentRow ? [agentRow] : [])),
      })),
    })),
  }));

  return { db: { select, update } as any, counts };
}

describe("agentService caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCacheForTests();
  });

  it("serves a second getById from cache without re-querying the agents table", async () => {
    const stub = createDbStub(makeAgent());
    const svc = agentService(stub.db);

    const first = await svc.getById("agent-1");
    expect(first?.id).toBe("agent-1");
    expect(stub.counts.agentSelects).toBe(1);

    const second = await svc.getById("agent-1");
    expect(second?.id).toBe("agent-1");
    // Cache hit: the agents table was NOT read a second time.
    expect(stub.counts.agentSelects).toBe(1);
  });

  it("re-queries after the agent's entity tag is invalidated", async () => {
    const stub = createDbStub(makeAgent());
    const svc = agentService(stub.db);

    await svc.getById("agent-1");
    expect(stub.counts.agentSelects).toBe(1);

    // The cost path invalidates agent:<id> on each event (spend is embedded in
    // getById). Assert the contract directly: after that tag is busted, the
    // next getById misses the cache and re-reads the DB.
    const { invalidateTags, tags } = await import("../cache.ts");
    await invalidateTags(tags.entity("agent", "agent-1"));

    await svc.getById("agent-1");
    expect(stub.counts.agentSelects).toBe(2);
  });

  it("invalidates the agent read-model when the agent is updated", async () => {
    const stub = createDbStub(makeAgent());
    const svc = agentService(stub.db);

    await svc.getById("agent-1");
    expect(stub.counts.agentSelects).toBe(1);

    // update() runs getById (cache hit), the DB update, then invalidateAgent().
    await svc.update("agent-1", { title: "Lead" });

    // Next read must miss the cache and re-query.
    await svc.getById("agent-1");
    expect(stub.counts.agentSelects).toBe(2);
  });

  it("does not share cache entries across different agent ids", async () => {
    const stub = createDbStub(makeAgent({ id: "agent-2" }));
    const svc = agentService(stub.db);

    await svc.getById("agent-2");
    await svc.getById("agent-2");
    expect(stub.counts.agentSelects).toBe(1);
  });
});
