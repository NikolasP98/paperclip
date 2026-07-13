import { z } from "zod";
import { ISSUE_PRIORITIES, PIPELINE_EXECUTION_MODES, PIPELINE_STEP_KINDS } from "../constants.js";
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
  onFailStepKey: z.string().trim().min(1).max(64).optional().nullable(),
  maxAttempts: z.number().int().min(1).max(20).optional().nullable(),
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

  const hasRetryTarget = Boolean(step.onFailStepKey);
  const hasAttemptLimit = typeof step.maxAttempts === "number";
  if (hasRetryTarget !== hasAttemptLimit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "onFailStepKey and maxAttempts must be configured together",
      path: hasRetryTarget ? ["maxAttempts"] : ["onFailStepKey"],
    });
  }
  if ((hasRetryTarget || hasAttemptLimit) && step.kind !== "eval" && step.kind !== "approval") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Retry routing is only supported on eval or approval steps",
      path: ["onFailStepKey"],
    });
  }
});

export const pipelineTriggerSchema = z
  .object({
    originKinds: z.array(z.string().trim().min(1)).optional(),
    labels: z.array(z.string().trim().min(1)).optional(),
    priorities: z.array(z.enum(ISSUE_PRIORITIES)).optional(),
  })
  .strict();

const pipelineStepsBaseSchema = z.array(pipelineStepSchema).min(1);

export const pipelineExecutionModeSchema = z.enum(PIPELINE_EXECUTION_MODES);

function validatePipelineSteps(
  steps: z.infer<typeof pipelineStepsBaseSchema>,
  executionMode: z.infer<typeof pipelineExecutionModeSchema>,
  ctx: z.RefinementCtx,
) {
  if (steps[0]?.kind !== "work") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "First step must be a work step", path: [0, "kind"] });
  }

  const seenKeys = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (seenKeys.has(step.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Step keys must be unique", path: [index, "key"] });
    }
    seenKeys.add(step.key);
  }

  const workStepCount = steps.filter((step) => step.kind === "work").length;
  if (executionMode === "inline" && workStepCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Inline pipelines allow exactly one work step, at position 0",
      path: [],
    });
  }

  for (const [index, step] of steps.entries()) {
    if (!step.onFailStepKey) continue;
    const targetIndex = steps.findIndex((candidate) => candidate.key === step.onFailStepKey);
    if (targetIndex < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "onFailStepKey must reference a pipeline step",
        path: [index, "onFailStepKey"],
      });
      continue;
    }
    if (steps[targetIndex]?.kind !== "work") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "onFailStepKey must reference a work step",
        path: [index, "onFailStepKey"],
      });
    }
    if (targetIndex >= index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "onFailStepKey must reference an earlier step",
        path: [index, "onFailStepKey"],
      });
    }
    if (executionMode !== "stage_tasks") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Retry routing requires stage_tasks execution mode",
        path: [index, "onFailStepKey"],
      });
    }
  }
}

/** Backward-compatible standalone validator: pipelines are inline unless explicitly stage-tasked. */
export const pipelineStepsSchema = pipelineStepsBaseSchema.superRefine((steps, ctx) => {
  validatePipelineSteps(steps, "inline", ctx);
});

export type PipelineStepInput = z.infer<typeof pipelineStepSchema>;
export type PipelineTriggerInput = z.infer<typeof pipelineTriggerSchema>;

export const createPipelineSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().optional().nullable(),
    projectId: z.string().uuid().optional().nullable(),
    executionMode: pipelineExecutionModeSchema.default("inline"),
    trigger: pipelineTriggerSchema.optional().nullable(),
    steps: pipelineStepsBaseSchema,
    sortOrder: z.number().int().optional(),
  })
  .superRefine((pipeline, ctx) => {
    validatePipelineSteps(pipeline.steps, pipeline.executionMode, ctx);
  });

export type CreatePipeline = z.infer<typeof createPipelineSchema>;

export const updatePipelineSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().optional().nullable(),
    executionMode: pipelineExecutionModeSchema.optional(),
    trigger: pipelineTriggerSchema.optional().nullable(),
    steps: pipelineStepsBaseSchema.optional(),
    sortOrder: z.number().int().optional(),
    archivedAt: z.coerce.date().optional().nullable(),
  })
  .superRefine((pipeline, ctx) => {
    if (pipeline.steps) validatePipelineSteps(pipeline.steps, pipeline.executionMode ?? "inline", ctx);
  });

export type UpdatePipeline = z.infer<typeof updatePipelineSchema>;
