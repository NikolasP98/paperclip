import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { authUsers, companies, companyMemberships, type Db } from '@paperclipai/db';
import { isUuidLike } from '@paperclipai/shared';

export type HubIdentityOptions = { secret: string; db: Db };

const ROLE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/;

function parseRoleKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('invalid roleKeys claim');
  const roleKeys: string[] = [];
  for (const valuePart of value) {
    if (typeof valuePart !== 'string') throw new Error('invalid roleKeys claim');
    const roleKey = valuePart.trim();
    if (!roleKey || roleKey.length > 80 || !ROLE_KEY_PATTERN.test(roleKey)) {
      throw new Error('invalid roleKeys claim');
    }
    if (!roleKeys.includes(roleKey)) roleKeys.push(roleKey);
  }
  return roleKeys;
}

function nullableClaim(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > maxLength)
    throw new Error('invalid identity claim');
  return value.trim() || null;
}

type VerifiedHubIdentity = {
  userId: string;
  companyId: string;
  email: string | null;
  name: string | null;
  roleKeys: string[];
};

class HubIdentityCompanyNotFoundError extends Error {}

function fallbackEmail(userId: string): string {
  const digest = createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return `hub-${digest}@federated.invalid`;
}

async function provisionHubIdentity(db: Db, identity: VerifiedHubIdentity): Promise<void> {
  await db.transaction(async (tx) => {
    // The company is provisioned independently by Paperclip. A signed token
    // may federate a user into that company, but it must never create or pick
    // an organization on the caller's behalf.
    const company = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, identity.companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw new HubIdentityCompanyNotFoundError();

    const now = new Date();
    const name = identity.name ?? identity.email ?? `Hub user ${identity.userId}`;
    const email = identity.email ?? fallbackEmail(identity.userId);
    const userUpdate = {
      updatedAt: now,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.email ? { email: identity.email, emailVerified: true } : {}),
    };

    await tx
      .insert(authUsers)
      .values({
        id: identity.userId,
        name,
        email,
        emailVerified: Boolean(identity.email),
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: authUsers.id,
        set: userUpdate,
      });

    // Hub federation grants only the minimum membership required for direct
    // human assignment. Never infer Paperclip ownership or instance admin
    // from Hub role keys, including Hub's own `owner` role.
    await tx
      .insert(companyMemberships)
      .values({
        companyId: identity.companyId,
        principalType: 'user',
        principalId: identity.userId,
        status: 'active',
        membershipRole: 'member',
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          companyMemberships.companyId,
          companyMemberships.principalType,
          companyMemberships.principalId,
        ],
        set: {
          status: 'active',
          membershipRole: 'member',
          updatedAt: now,
        },
      });
  });
}

export function hubIdentityMiddleware(opts: HubIdentityOptions): RequestHandler {
  const key = new Uint8Array(Buffer.from(opts.secret, 'base64'));
  return async (req, res, next) => {
    const header = req.headers['x-hub-identity'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) {
      // A validated board/agent bearer actor remains a supported API client
      // when Hub identity federation is enabled. Anonymous traffic still
      // fails closed under the Hub-only deployment posture.
      if (req.actor?.type === 'board' || req.actor?.type === 'agent') {
        next();
        return;
      }
      res.status(401).json({ error: 'missing_hub_identity' });
      return;
    }
    let identity: VerifiedHubIdentity;
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
      const jwtCompanyId = typeof payload.companyId === 'string' ? payload.companyId.trim() : '';
      if (!userId || userId.length > 200 || !isUuidLike(jwtCompanyId)) {
        res.status(401).json({ error: 'invalid_hub_identity' });
        return;
      }
      const roleKeys = parseRoleKeys(payload.roleKeys);
      identity = {
        userId,
        companyId: jwtCompanyId,
        email: nullableClaim(payload.email, 320),
        name: nullableClaim(payload.name, 200),
        roleKeys,
      };
    } catch {
      res.status(401).json({ error: 'invalid_hub_identity' });
      return;
    }

    // Path scope is validated before any persistence. The JWT may provision
    // only its own subject into its own pre-existing company.
    const m = req.path.match(/^\/companies\/([^/]+)/);
    if (m && identity.companyId !== m[1]) {
      res.status(403).json({ error: 'company_scope_mismatch' });
      return;
    }

    try {
      await provisionHubIdentity(opts.db, identity);
    } catch (error) {
      if (error instanceof HubIdentityCompanyNotFoundError) {
        res.status(403).json({ error: 'company_scope_invalid' });
        return;
      }
      next(error);
      return;
    }

    req.user = {
      id: identity.userId,
      email: identity.email,
      name: identity.name,
      roleKeys: identity.roleKeys,
    };
    req.companyId = identity.companyId;
    // actorMiddleware runs before this federation guard. Replace whichever
    // actor it resolved with the signed Hub subject so user/role HITL
    // authorization never relies on a board key's owner or plain headers.
    req.actor = {
      type: 'board',
      userId: identity.userId,
      userName: identity.name,
      userEmail: identity.email,
      companyIds: [identity.companyId],
      memberships: [{ companyId: identity.companyId, membershipRole: 'member', status: 'active' }],
      isInstanceAdmin: false,
      roleKeys: identity.roleKeys,
      source: 'hub_identity',
    };
    next();
  };
}
