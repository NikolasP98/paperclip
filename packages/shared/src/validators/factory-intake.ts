import { z } from 'zod';

const roleKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/);
const factoryScopeSchema = z.enum([
  'auth',
  'crm',
  'core',
  'gateway',
  'workforce',
  'ui',
  'data',
  'plugins',
  'ops',
  'docs',
]);

export const factoryIntakeSourceSchema = z
  .object({
    kind: z.literal('hub_assistant'),
    route: z.string().trim().min(1).max(500),
    selectedAgentId: z.string().uuid().optional(),
  })
  .strict();

export const factoryRoutingTargetSchema = z.union([
  z.object({ type: z.literal('user') }).strict(),
  z.object({ type: z.literal('role'), roleKeys: z.array(roleKeySchema).min(1).max(20) }).strict(),
]);

export const createFactoryIntakeSchema = z
  .object({
    request: z.string().trim().min(1).max(100_000),
    source: factoryIntakeSourceSchema,
    idempotencyKey: z.string().trim().min(1).max(240),
    routingTarget: factoryRoutingTargetSchema.optional(),
  })
  .strict();

const existingProjectDecisionSchema = z
  .object({
    kind: z.literal('existing_project'),
    projectId: z.string().uuid(),
  })
  .strict();

const newProjectDecisionSchema = z
  .object({
    kind: z.literal('new_project'),
    name: z.string().trim().min(1).max(240),
    description: z.string().trim().max(4_000).optional().nullable(),
    repositoryKey: z.string().trim().min(1).max(120),
    groupKey: z.string().trim().min(1).max(120).optional(),
    scopes: z.array(factoryScopeSchema).max(64).optional(),
  })
  .strict();

export const decideFactoryIntakeRoutingSchema = z
  .object({
    decision: z.union([
      existingProjectDecisionSchema,
      newProjectDecisionSchema,
      z.object({ kind: z.literal('reject') }).strict(),
    ]),
    note: z.string().trim().max(4_000).optional().nullable(),
  })
  .strict();

export type CreateFactoryIntake = z.infer<typeof createFactoryIntakeSchema>;
export type DecideFactoryIntakeRouting = z.infer<typeof decideFactoryIntakeRoutingSchema>;
