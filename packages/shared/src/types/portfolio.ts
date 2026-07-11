import type { PortfolioStatus } from "../constants.js";

export interface Portfolio {
  id: string;
  companyId: string;
  name: string;
  objective: string | null;
  guardrails: string | null;
  charter: string | null;
  status: PortfolioStatus;
  leadAgentId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}
