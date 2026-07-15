export {};

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        keyId?: string;
        runId?: string;
        /** Trusted Hub role claims. Present only after a signed Hub identity is verified. */
        roleKeys?: string[];
        source?: "local_implicit" | "session" | "hub_identity" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant" | "none";
      };
      user?: { id: string; email: string | null; name: string | null; roleKeys?: string[] };
      companyId?: string | null;
    }
  }
}
