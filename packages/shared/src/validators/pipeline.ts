import { z } from "zod";
import { ISSUE_PRIORITIES, PIPELINE_STEP_KINDS } from "../constants.js";
import { issueExecutionStagePrincipalSchema } from "./issue.js";

/** Step participant — agent or user. Same shape/rules as an execution stage principal. */
export const pipelineStepParticipantSchema = issueExecutionStagePrincipalSchema;

const pipelineStepBaseSchema = z.object({
  key: z.string().trim().min(1).max(64),
  kind: z.enum(PIPELINE_STEP_KINDS),
  label: z.string().trim().min(1).max(120),
  participant: pipelineStepParticipantSchema,
  adapterOverrides: z.record(z.string(), z.unknown()).optional().nullable(),
  rubric: z.string().trim().min(1).max(20000).optional().nullable(),
  minScore: z.number().optional().nullable(),
  maxScore: z.number().optional().nullable(),
});

export const pipelineStepSchema = pipelineStepBaseSchema.superRefine((step, ctx) => {
  if (step.kind === "work" && step.participant.type !== "agent") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Work step participant must be an agent",
      path: ["participant", "type"],
    });
  }
  if (step.kind === "eval") {
    if (!step.rubric) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Eval steps require a rubric", path: ["rubric"] });
    }
    if (typeof step.minScore !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Eval steps require minScore", path: ["minScore"] });
    }
    if (typeof step.maxScore !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Eval steps require maxScore", path: ["maxScore"] });
    } else if (typeof step.minScore === "number" && step.maxScore < step.minScore) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "maxScore must be >= minScore", path: ["maxScore"] });
    }
  }
});

export const pipelineTriggerSchema = z
  .object({
    originKinds: z.array(z.string().trim().min(1)).optional(),
    labels: z.array(z.string().trim().min(1)).optional(),
    priorities: z.array(z.enum(ISSUE_PRIORITIES)).optional(),
  })
  .strict();

export const pipelineStepsSchema = z
  .array(pipelineStepSchema)
  .min(1)
  .superRefine((steps, ctx) => {
    if (steps[0]?.kind !== "work") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "First step must be a work step", path: [0, "kind"] });
    }
    const workStepCount = steps.filter((step) => step.kind === "work").length;
    if (workStepCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one work step is allowed, at position 0",
        path: [],
      });
    }
  });

export type PipelineStepInput = z.infer<typeof pipelineStepSchema>;
export type PipelineTriggerInput = z.infer<typeof pipelineTriggerSchema>;

export const createPipelineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  trigger: pipelineTriggerSchema.optional().nullable(),
  steps: pipelineStepsSchema,
  sortOrder: z.number().int().optional(),
});

export type CreatePipeline = z.infer<typeof createPipelineSchema>;

export const updatePipelineSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().optional().nullable(),
  trigger: pipelineTriggerSchema.optional().nullable(),
  steps: pipelineStepsSchema.optional(),
  sortOrder: z.number().int().optional(),
  archivedAt: z.coerce.date().optional().nullable(),
});

export type UpdatePipeline = z.infer<typeof updatePipelineSchema>;
