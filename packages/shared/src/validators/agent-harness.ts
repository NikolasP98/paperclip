import { z } from "zod";
export const agentHarnessRoleKeySchema = z.enum([
  "issue-classifier",
  "spec-planner",
  "implementer",
  "evaluator",
  "code-merger",
  "portfolio-monitor",
  "learning-reviewer",
  "generic",
]);
export const agentHarnessIdsQuerySchema = z.object({
  agentIds: z.string().transform((value, ctx) => {
    const ids = [
      ...new Set(
        value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (
      ids.length === 0 ||
      ids.length > 50 ||
      ids.some((id) => !z.string().uuid().safeParse(id).success)
    ) {
      ctx.addIssue({ code: "custom", message: "agentIds must contain 1-50 comma-separated UUIDs" });
      return z.NEVER;
    }
    return ids;
  }),
});
export const roleRoutingPolicySchema = z.object({
  roleKey: agentHarnessRoleKeySchema,
  runtimeClass: z.enum(["coding", "evaluation", "monitoring", "general"]),
  primaryAdapterType: z.string().min(1),
  primaryModel: z.string().nullable(),
  fallbackModels: z.array(z.string()).max(8),
  tools: z.array(z.string()).max(64),
  skills: z.array(z.string()).max(64),
  proposalScoreThreshold: z.number().min(0).max(10),
  scoreFloor: z.number().min(0).max(10),
  maxLatencyMs: z.number().int().positive(),
  maxFallbackRate: z.number().min(0).max(1),
  maxCostPerAcceptedOutcomeCents: z.number().nonnegative(),
});
