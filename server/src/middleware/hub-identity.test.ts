import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  type Db,
} from '@paperclipai/db';
import { SignJWT } from 'jose';
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from '../__tests__/helpers/embedded-postgres.js';
import { hubIdentityMiddleware } from './hub-identity.js';

const SECRET = 'a'.repeat(43) + '=';
const key = new Uint8Array(Buffer.from(SECRET, 'base64'));
const noWriteDb = {} as Db;

async function tokenWith(claims: Record<string, unknown>, ttl = 60) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(key);
}

function responseDouble() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  return { response: { status, json } as any, status, json };
}

describe('hubIdentityMiddleware validation', () => {
  it('returns 401 on missing header', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET, db: noWriteDb });
    const req: any = { headers: {}, path: '/health' };
    const { response, status } = responseDouble();
    const next = vi.fn();
    await mw(req, response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows an already-authenticated bearer actor without Hub identity', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET, db: noWriteDb });
    const req: any = {
      headers: {},
      path: '/companies/c1/inbox',
      actor: { type: 'board', source: 'board_key' },
    };
    const next = vi.fn();
    await mw(req, {} as any, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects malformed role claims before touching the database', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET, db: noWriteDb });
    const companyId = randomUUID();
    const req: any = {
      headers: {
        'x-hub-identity': await tokenWith({
          userId: 'u1',
          companyId,
          roleKeys: ['owner', 'not valid'],
        }),
      },
      path: `/companies/${companyId}/inbox`,
      actor: { type: 'none', source: 'none' },
    };
    const { response, status } = responseDouble();
    const next = vi.fn();
    await mw(req, response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 on invalid token before touching the database', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET, db: noWriteDb });
    const req: any = { headers: { 'x-hub-identity': 'garbage' }, path: '/health' };
    const { response, status } = responseDouble();
    const next = vi.fn();
    await mw(req, response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 on a path/JWT company mismatch before touching the database', async () => {
    const mw = hubIdentityMiddleware({ secret: SECRET, db: noWriteDb });
    const jwtCompanyId = randomUUID();
    const pathCompanyId = randomUUID();
    const req: any = {
      headers: {
        'x-hub-identity': await tokenWith({
          userId: 'u1',
          email: null,
          name: null,
          companyId: jwtCompanyId,
        }),
      },
      path: `/companies/${pathCompanyId}/dashboard`,
    };
    const { response, status } = responseDouble();
    const next = vi.fn();
    await mw(req, response, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb('hubIdentityMiddleware federated persistence', () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('paperclip-hub-identity-');
    db = createDb(temp.connectionString);
  }, 20_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  async function seedCompany(id = randomUUID()) {
    await db.insert(companies).values({
      id,
      name: `Hub federation ${id}`,
      issuePrefix: `H${id.replaceAll('-', '').slice(0, 7)}`.toUpperCase(),
    });
    return id;
  }

  async function invoke(input: { token: string; path: string }) {
    const mw = hubIdentityMiddleware({ secret: SECRET, db });
    const req: any = {
      headers: { 'x-hub-identity': input.token },
      path: input.path,
      actor: { type: 'none', source: 'none' },
    };
    const result = responseDouble();
    const next = vi.fn();
    await mw(req, result.response, next);
    return { req, next, ...result };
  }

  it('syncs the exact signed user as an active member without owner or admin authority', async () => {
    const companyId = await seedCompany();
    const userId = `hub-user-${randomUUID()}`;
    const result = await invoke({
      token: await tokenWith({
        userId,
        email: 'user@example.test',
        name: 'Hub User',
        companyId,
        roleKeys: ['owner'],
      }),
      path: `/companies/${companyId}/inbox`,
    });

    const user = await db.select().from(authUsers).where(eq(authUsers.id, userId));
    const membership = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, 'user'),
          eq(companyMemberships.principalId, userId),
        ),
      );

    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({
      name: 'Hub User',
      email: 'user@example.test',
      emailVerified: true,
    });
    expect(membership).toHaveLength(1);
    expect(membership[0]).toMatchObject({ status: 'active', membershipRole: 'member' });
    expect(
      await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, userId)),
    ).toEqual([]);
    expect(result.req.actor).toMatchObject({
      userId,
      companyIds: [companyId],
      isInstanceAdmin: false,
      roleKeys: ['owner'],
      source: 'hub_identity',
    });
    expect(result.next).toHaveBeenCalledOnce();
  });

  it('is idempotent and refreshes profile plus least-privilege membership state', async () => {
    const companyId = await seedCompany();
    const userId = `hub-user-${randomUUID()}`;
    await invoke({
      token: await tokenWith({ userId, email: 'old@example.test', name: 'Old Name', companyId }),
      path: `/companies/${companyId}/inbox`,
    });
    await db
      .update(companyMemberships)
      .set({ status: 'archived', membershipRole: 'owner' })
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalId, userId),
        ),
      );

    const second = await invoke({
      token: await tokenWith({ userId, email: 'new@example.test', name: 'New Name', companyId }),
      path: `/companies/${companyId}/inbox`,
    });
    const users = await db.select().from(authUsers).where(eq(authUsers.id, userId));
    const memberships = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalId, userId),
        ),
      );

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ name: 'New Name', email: 'new@example.test' });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ status: 'active', membershipRole: 'member' });
    expect(second.next).toHaveBeenCalledOnce();
  });

  it('adds membership only to the signed company and leaves another company untouched', async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const userId = `hub-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: 'Existing User',
      email: 'existing@example.test',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: otherCompanyId,
      principalType: 'user',
      principalId: userId,
      status: 'active',
      membershipRole: 'owner',
    });

    await invoke({
      token: await tokenWith({
        userId,
        email: 'existing@example.test',
        name: 'Existing User',
        companyId,
      }),
      path: `/companies/${companyId}/inbox`,
    });
    const memberships = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.principalId, userId));

    expect(memberships).toHaveLength(2);
    expect(memberships.find((row) => row.companyId === companyId)).toMatchObject({
      status: 'active',
      membershipRole: 'member',
    });
    expect(memberships.find((row) => row.companyId === otherCompanyId)).toMatchObject({
      status: 'active',
      membershipRole: 'owner',
    });
  });

  it('does not write for an invalid JWT or an unknown claimed company', async () => {
    const userId = `hub-user-${randomUUID()}`;
    const usersBefore = await db.select({ id: authUsers.id }).from(authUsers);
    const membershipsBefore = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships);
    const invalid = await invoke({ token: 'garbage', path: `/companies/${randomUUID()}/inbox` });
    expect(invalid.status).toHaveBeenCalledWith(401);
    expect(await db.select({ id: authUsers.id }).from(authUsers)).toEqual(usersBefore);
    expect(await db.select({ id: companyMemberships.id }).from(companyMemberships)).toEqual(
      membershipsBefore,
    );

    const unknownCompanyId = randomUUID();
    const unknown = await invoke({
      token: await tokenWith({
        userId,
        email: 'never@example.test',
        name: 'Never Written',
        companyId: unknownCompanyId,
      }),
      path: `/companies/${unknownCompanyId}/inbox`,
    });
    expect(unknown.status).toHaveBeenCalledWith(403);

    expect(await db.select().from(authUsers).where(eq(authUsers.id, userId))).toEqual([]);
    expect(
      await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, userId)),
    ).toEqual([]);
  });
});
