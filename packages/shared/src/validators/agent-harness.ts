import { z } from "zod";

const HARNESS_GUIDANCE_SECRET =
  /(?:sk|gh[opusr])_[a-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:authorization\s*:\s*bearer|(?:api[_ -]?key|token|password|secret)\s*[:=])\s*\S{8,}/i;

export const harnessRoleGuidanceSchema = z
  .string()
  .trim()
  .min(20)
  .max(6_000)
  .refine((value) => !HARNESS_GUIDANCE_SECRET.test(value), {
    message: "Harness guidance must not contain credentials or secret-like values",
  });

export const harnessGuidanceChangeSchema = z
  .object({
    kind: z.literal("replace_role_guidance"),
    baseRevisionId: z.string().uuid(),
    before: harnessRoleGuidanceSchema,
    after: harnessRoleGuidanceSchema,
  })
  .strict()
  .refine((value) => value.before !== value.after, {
    message: "Replacement guidance must differ from the base guidance",
    path: ["after"],
  });

const harnessCapabilityNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Capability names must not contain control characters",
  });

const harnessCapabilityListSchema = z
  .array(harnessCapabilityNameSchema)
  .max(64)
  .transform((values) => [...new Set(values)].sort((left, right) => left.localeCompare(right)));

export const harnessCapabilitySelectionSchema = z
  .object({
    tools: harnessCapabilityListSchema,
    skills: harnessCapabilityListSchema,
  })
  .strict();

export const harnessCapabilitySelectionChangeSchema = z
  .object({
    kind: z.literal("replace_active_capabilities"),
    baseRevisionId: z.string().uuid(),
    before: harnessCapabilitySelectionSchema,
    after: harnessCapabilitySelectionSchema,
  })
  .strict()
  .refine(
    (value) =>
      JSON.stringify(value.before.tools) !== JSON.stringify(value.after.tools) ||
      JSON.stringify(value.before.skills) !== JSON.stringify(value.after.skills),
    {
      message: "Active capability selection must change at least one field",
      path: ["after"],
    },
  );

export const harnessProposalChangeSchema = z.union([
  harnessGuidanceChangeSchema,
  harnessCapabilitySelectionChangeSchema,
]);

export const createHarnessGuidanceProposalSchema = z
  .object({
    signalId: z.string().uuid(),
    rationale: z.string().trim().min(10).max(2_000),
    change: harnessGuidanceChangeSchema,
  })
  .strict();

export const createHarnessCapabilityProposalSchema = z
  .object({
    signalId: z.string().uuid(),
    rationale: z.string().trim().min(10).max(2_000),
    change: harnessCapabilitySelectionChangeSchema,
  })
  .strict();

export const createHarnessProposalSchema = z
  .object({
    signalId: z.string().uuid(),
    rationale: z.string().trim().min(10).max(2_000),
    change: harnessProposalChangeSchema,
  })
  .strict();

export const rejectHarnessGuidanceProposalSchema = z
  .object({ reason: z.string().trim().min(3).max(2_000) })
  .strict();

export const rollbackHarnessGuidanceProposalSchema = z
  .object({ reason: z.string().trim().min(3).max(2_000).optional() })
  .strict();

export const emptyHarnessGuidanceDecisionSchema = z.object({}).strict();

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
