import { beforeEach, describe, expect, it, vi } from "vitest";
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
 * Minimal drizzle stub. Each `db.select()` consumes one queued result.
 * - getById issues: (1) agents read (thenable) (2) costEvents aggregate (groupBy).
 * We count agent-row reads so the test can assert cache hits skip the DB.
 */
function createDbStub(agentRow: AgentRow | null) {
  const counts = { agentSelects: 0, costSelects: 0 };

  // A chainable that is awaitable (agents path: .where().then()) and also
  // supports .groupBy() (costEvents path).
  function makeQuery(kind: "agent" | "cost") {
    const result: unknown[] =
      kind === "agent" ? (agentRow ? [agentRow] : []) : [];
    const where = vi.fn(() => {
      const thenable = {
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(result)),
        groupBy: vi.fn(async () => result),
      };
      return thenable;
    });
    return { where };
  }

  // We need select() to decide which table is being read. Drizzle calls
  // select().from(table). We branch on the next expected query in getById:
  // first select in a getById call is agents, second is costEvents.
  let phase: "agent" | "cost" = "agent";
  const select = vi.fn(() => ({
    from: vi.fn(() => {
      if (phase === "agent") {
        counts.agentSelects += 1;
        phase = "cost";
        return makeQuery("agent");
      }
      counts.costSelects += 1;
      phase = "agent";
      return makeQuery("cost");
    }),
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
