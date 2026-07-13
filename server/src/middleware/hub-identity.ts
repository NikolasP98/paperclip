import type { RequestHandler } from 'express';
import { jwtVerify } from 'jose';

export type HubIdentityOptions = { secret: string };

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
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('invalid identity claim');
  return value;
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
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
      const jwtCompanyId = typeof payload.companyId === 'string' ? payload.companyId.trim() : '';
      if (!userId || userId.length > 200 || !jwtCompanyId || jwtCompanyId.length > 200) {
        res.status(401).json({ error: 'invalid_hub_identity' });
        return;
      }
      const roleKeys = parseRoleKeys(payload.roleKeys);
      req.user = {
        id: userId,
        email: nullableClaim(payload.email, 320),
        name: nullableClaim(payload.name, 200),
        roleKeys,
      };
      req.companyId = jwtCompanyId;

      // Correction A — path-scope enforcement.
      const m = req.path.match(/^\/companies\/([^/]+)/);
      if (m) {
        const pathCompanyId = m[1];
        if (jwtCompanyId !== pathCompanyId) {
          res.status(403).json({ error: 'company_scope_mismatch' });
          return;
        }
      }
      // actorMiddleware runs before this federation guard. Replace whichever
      // actor it resolved with the signed Hub subject so user/role HITL
      // authorization never relies on a board key's owner or plain headers.
      req.actor = {
        type: 'board',
        userId,
        userName: req.user.name,
        userEmail: req.user.email,
        companyIds: [jwtCompanyId],
        memberships: [{ companyId: jwtCompanyId, membershipRole: 'member', status: 'active' }],
        isInstanceAdmin: false,
        roleKeys,
        source: 'hub_identity',
      };
      next();
    } catch {
      res.status(401).json({ error: 'invalid_hub_identity' });
    }
  };
}
