#!/usr/bin/env tsx
/**
 * Backfill the default fallback chain on every agent that doesn't have one.
 * Idempotent — agents that already have a fallbackChain are left untouched.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-fallback-chain.ts          # dry run (shows what would change)
 *   pnpm tsx scripts/backfill-fallback-chain.ts --apply  # actually write
 *
 * Requires DATABASE_URL in env (Infisical run via `./infisical-dev.sh` works).
 */
import { eq } from "drizzle-orm";
import { agents, createDb } from "@paperclipai/db";

type FallbackEntry = {
  type: "pi_local";
  model: string;
  envAlias: { OPENROUTER_API_KEY: string };
};

const DEFAULTS_BY_TIER: Record<"opus" | "sonnet" | "haiku", { secondary: string; tertiary: string }> = {
  opus: {
    secondary: "openrouter/anthropic/claude-opus-4.7",
    tertiary: "openrouter/anthropic/claude-haiku-4.5",
  },
  sonnet: {
    secondary: "openrouter/anthropic/claude-sonnet-4.5",
    tertiary: "openrouter/anthropic/claude-haiku-4.5",
  },
  haiku: {
    secondary: "openrouter/anthropic/claude-haiku-4.5",
    tertiary: "openrouter/anthropic/claude-haiku-4.5",
  },
};

function inferTier(adapterConfig: Record<string, unknown>): "opus" | "sonnet" | "haiku" {
  const model = String(adapterConfig.model ?? "").toLowerCase();
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

function buildChain(tier: "opus" | "sonnet" | "haiku"): FallbackEntry[] {
  const tierDefaults = DEFAULTS_BY_TIER[tier];
  return [
    {
      type: "pi_local",
      model: tierDefaults.secondary,
      envAlias: { OPENROUTER_API_KEY: "OPENROUTER_FALLBACK_API_KEY" },
    },
    {
      type: "pi_local",
      model: tierDefaults.tertiary,
      envAlias: { OPENROUTER_API_KEY: "OPENROUTER_TERTIARY_API_KEY" },
    },
  ];
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const db = createDb(dbUrl);

  const all = await db.select().from(agents);
  let touched = 0;

  for (const agent of all) {
    const cfg = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    if (Array.isArray(cfg.fallbackChain) && cfg.fallbackChain.length > 0) continue;
    const tier = inferTier(cfg);
    const newChain = buildChain(tier);
    console.log(`agent=${agent.name} (${agent.id.slice(0, 8)}) tier=${tier} → 2 fallback levels`);
    if (apply) {
      await db
        .update(agents)
        .set({
          adapterConfig: { ...cfg, fallbackChain: newChain },
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id));
    }
    touched += 1;
  }

  console.log("---");
  console.log(`${apply ? "Updated" : "Would update"} ${touched} of ${all.length} agents`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
