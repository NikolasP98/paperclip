import { describe, it, expect, vi } from 'vitest';
import { hubIdentityMiddleware } from './hub-identity.js';
import { SignJWT } from 'jose';

const SECRET = 'a'.repeat(43) + '=';
const key = new Uint8Array(Buffer.from(SECRET, 'base64'));

async function tokenWith(claims: Record<string, unknown>, ttl = 60) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(key);
}

describe('hubIdentityMiddleware', () => {
  it('hydrates req.user and req.companyId on valid token', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET });
    const req: any = { headers: {}, path: '/health', get(name: string) { return req.headers[name.toLowerCase()]; } };
    req.headers['x-hub-identity'] = await tokenWith({
      userId: 'u1', email: 'a@b.c', name: 'A', companyId: 'c1', roleKeys: ['engineering_lead', 'owner'],
    });
    req.actor = { type: 'none', source: 'none' };
    const next = vi.fn();
    await mw(req, {} as any, next);
    expect(req.user).toEqual({ id: 'u1', email: 'a@b.c', name: 'A', roleKeys: ['engineering_lead', 'owner'] });
    expect(req.companyId).toBe('c1');
    expect(req.actor).toMatchObject({
      type: 'board', userId: 'u1', companyIds: ['c1'], roleKeys: ['engineering_lead', 'owner'], source: 'hub_identity',
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 401 on missing header', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET });
    const req: any = { headers: {}, path: '/health' };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res: any = { status, json };
    const next = vi.fn();
    await mw(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows an already-authenticated bearer actor without Hub identity', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET });
    const req: any = { headers: {}, path: '/companies/c1/inbox', actor: { type: 'board', source: 'board_key' } };
    const next = vi.fn();
    await mw(req, {} as any, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects malformed role claims instead of accepting partial authority', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET });
    const req: any = {
      headers: { 'x-hub-identity': await tokenWith({ userId: 'u1', companyId: 'c1', roleKeys: ['owner', 'not valid'] }) },
      path: '/companies/c1/inbox',
      actor: { type: 'none', source: 'none' },
    };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    await mw(req, { status, json } as any, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 on invalid token', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET });
    const req: any = { headers: { 'x-hub-identity': 'garbage' }, path: '/health' };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res: any = { status, json };
    const next = vi.fn();
    await mw(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 403 when path companyId mismatches JWT companyId', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET });
    const req: any = {
      headers: { 'x-hub-identity': await tokenWith({ userId: 'u1', email: null, name: null, companyId: 'c1' }) },
      path: '/companies/c2/dashboard',
    };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res: any = { status, json };
    const next = vi.fn();
    await mw(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
