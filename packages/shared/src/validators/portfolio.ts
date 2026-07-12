import { z } from "zod";
import { PORTFOLIO_STATUSES } from "../constants.js";

export const createPortfolioSchema = z.object({
  name: z.string().min(1),
  objective: z.string().optional().nullable(),
  guardrails: z.string().optional().nullable(),
  charter: z.string().optional().nullable(),
  status: z.enum(PORTFOLIO_STATUSES).optional().default("active"),
  leadAgentId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreatePortfolio = z.infer<typeof createPortfolioSchema>;

export const updatePortfolioSchema = createPortfolioSchema.partial();

export type UpdatePortfolio = z.infer<typeof updatePortfolioSchema>;
