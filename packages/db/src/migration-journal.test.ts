import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ponytail: check-migration-numbering.ts (run as part of build/typecheck) already
// enforces duplicate-free, strictly-ordered migration files/journal tags and
// journal/file count+order parity. This test adds only what that script doesn't
// check: idx sequential from 0 and `when` strictly increasing.
const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = path.join(migrationsDir, "meta/_journal.json");

describe("migration journal", () => {
  it("has sequential idx, strictly increasing when, no duplicate tags, and matches sql file count", () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entries = journal.entries;
    const sqlFileCount = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).length;

    expect(entries.length).toBe(sqlFileCount);

    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });

    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
    }

    const tags = entries.map((e) => e.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});
