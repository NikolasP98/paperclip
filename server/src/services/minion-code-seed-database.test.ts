import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { withMinionCodeSeedDatabase } from "./minion-code-seed-database.js";

function testDatabase(events: string[]) {
  const end = vi.fn(async (options: { timeout: number }) => {
    events.push(`close:${options.timeout}`);
  });
  const db = { $client: { end } } as unknown as Db;
  const factory = vi.fn(() => db);
  return { db, end, factory };
}

describe("withMinionCodeSeedDatabase", () => {
  it("closes the database pool after a successful seed operation", async () => {
    const events: string[] = [];
    const { db, end, factory } = testDatabase(events);

    const result = await withMinionCodeSeedDatabase(
      "postgres://seed-test",
      async (receivedDb) => {
        expect(receivedDb).toBe(db);
        events.push("seed");
        return { applied: true };
      },
      factory,
    );

    expect(result).toEqual({ applied: true });
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith("postgres://seed-test");
    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
    expect(events).toEqual(["seed", "close:0"]);
  });

  it("closes the database pool when the seed operation fails", async () => {
    const events: string[] = [];
    const { end, factory } = testDatabase(events);
    const failure = new Error("seed failed");

    await expect(
      withMinionCodeSeedDatabase(
        "postgres://seed-test",
        async () => {
          events.push("seed");
          throw failure;
        },
        factory,
      ),
    ).rejects.toBe(failure);

    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
    expect(events).toEqual(["seed", "close:0"]);
  });
});
