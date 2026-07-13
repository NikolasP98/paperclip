import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";

const ORIGINAL_TRUSTED_BOARD_ORIGINS = process.env.PAPERCLIP_TRUSTED_BOARD_ORIGINS;

afterEach(() => {
  if (ORIGINAL_TRUSTED_BOARD_ORIGINS === undefined) {
    delete process.env.PAPERCLIP_TRUSTED_BOARD_ORIGINS;
  } else {
    process.env.PAPERCLIP_TRUSTED_BOARD_ORIGINS = ORIGINAL_TRUSTED_BOARD_ORIGINS;
  }
});

function createApp(
  actorType: "board" | "agent",
  boardSource: "session" | "local_implicit" | "board_key" | "cloud_tenant" = "session",
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorType === "board"
      ? { type: "board", userId: "board", source: boardSource }
      : { type: "agent", agentId: "agent-1" };
    next();
  });
  app.use(boardMutationGuard());
  app.post("/mutate", (_req, res) => {
    res.status(204).end();
  });
  app.get("/read", (_req, res) => {
    res.status(204).end();
  });
  return app;
}

describe("boardMutationGuard", () => {
  it("allows safe methods for board actor", async () => {
    const app = createApp("board");
    const res = await request(app).get("/read");
    expect([200, 204]).toContain(res.status);
  });

  it("blocks board mutations without trusted origin", () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: { type: "board", userId: "board", source: "session" },
      header: () => undefined,
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Board mutation requires trusted browser origin",
    });
  });

  it("allows local implicit board mutations without origin", async () => {
    const app = createApp("board", "local_implicit");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board bearer-key mutations without origin", async () => {
    const app = createApp("board", "board_key");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows trusted Cloud tenant mutations without origin", async () => {
    const app = createApp("board", "cloud_tenant");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from trusted origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "http://localhost:3100")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from trusted referer origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Referer", "http://localhost:3100/issues/abc")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from an explicitly configured trusted origin", async () => {
    process.env.PAPERCLIP_TRUSTED_BOARD_ORIGINS =
      "https://board.example.com, http://board.internal:8080/";
    const app = createApp("board");

    const originResponse = await request(app)
      .post("/mutate")
      .set("Origin", "https://board.example.com")
      .send({ ok: true });
    const refererResponse = await request(app)
      .post("/mutate")
      .set("Referer", "http://board.internal:8080/issues/abc")
      .send({ ok: true });

    expect([200, 204]).toContain(originResponse.status);
    expect([200, 204]).toContain(refererResponse.status);
  });

  it("rejects malformed configured origins and unlisted browser origins", async () => {
    process.env.PAPERCLIP_TRUSTED_BOARD_ORIGINS = [
      "https://trusted.example.com",
      "not-an-origin",
      "ftp://board.example.com",
      "https://board.example.com/path",
      "https://user:password@board.example.com",
    ].join(",");
    const app = createApp("board");

    const malformedConfigResponse = await request(app)
      .post("/mutate")
      .set("Origin", "https://board.example.com")
      .send({ ok: true });
    const malformedHeaderResponse = await request(app)
      .post("/mutate")
      .set("Origin", "https://trusted.example.com/path")
      .send({ ok: true });
    const unlistedResponse = await request(app)
      .post("/mutate")
      .set("Origin", "https://unlisted.example.com")
      .send({ ok: true });

    expect(malformedConfigResponse.status).toBe(403);
    expect(malformedHeaderResponse.status).toBe(403);
    expect(unlistedResponse.status).toBe(403);
  });

  it("allows board mutations when x-forwarded-host matches origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "127.0.0.1")
      .set("X-Forwarded-Host", "10.90.10.20:3443")
      .set("Origin", "https://10.90.10.20:3443")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("blocks board mutations when x-forwarded-host does not match origin", async () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: { type: "board", userId: "board", source: "session" },
      header: (name: string) => {
        if (name === "host") return "127.0.0.1";
        if (name === "x-forwarded-host") return "10.90.10.20:3443";
        if (name === "origin") return "https://evil.example.com";
        return undefined;
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Board mutation requires trusted browser origin",
    });
  });

  it("still allows matching x-forwarded-host when an origin allowlist is configured", async () => {
    process.env.PAPERCLIP_TRUSTED_BOARD_ORIGINS = "https://board.example.com";
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "127.0.0.1")
      .set("X-Forwarded-Host", "10.90.10.20:3443")
      .set("Origin", "https://10.90.10.20:3443")
      .send({ ok: true });

    expect([200, 204]).toContain(res.status);
  });

  it("does not block authenticated agent mutations", async () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: { type: "agent", agentId: "agent-1" },
      header: () => undefined,
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
