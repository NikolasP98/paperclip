import type { RequestHandler } from 'express';
import { jwtVerify } from 'jose';

export type HubIdentityOptions = { secret: string };

export function hubIdentityMiddleware(opts: HubIdentityOptions): RequestHandler {
  const key = new Uint8Array(Buffer.from(opts.secret, 'base64'));
  return async (req, res, next) => {
    const header = req.headers['x-hub-identity'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) {
      res.status(401).json({ error: 'missing_hub_identity' });
      return;
    }
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      const userId = String(payload.userId ?? '');
      if (!userId) {
        res.status(401).json({ error: 'invalid_hub_identity' });
        return;
      }
      (req as any).user = {
        id: userId,
        email: (payload.email as string | null) ?? null,
        name: (payload.name as string | null) ?? null,
      };
      const jwtCompanyId = (payload.companyId as string | null) ?? null;
      (req as any).companyId = jwtCompanyId;

      // Correction A — path-scope enforcement.
      const m = req.path.match(/^\/companies\/([^/]+)/);
      if (m) {
        const pathCompanyId = m[1];
        if (jwtCompanyId !== pathCompanyId) {
          res.status(403).json({ error: 'company_scope_mismatch' });
          return;
        }
      }
      next();
    } catch {
      res.status(401).json({ error: 'invalid_hub_identity' });
    }
  };
}
