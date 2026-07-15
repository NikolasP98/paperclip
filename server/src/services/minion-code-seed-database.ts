import { createDb, type Db } from "@paperclipai/db";

type DatabaseFactory = (databaseUrl: string) => Db;

export async function withMinionCodeSeedDatabase<T>(
  databaseUrl: string,
  operation: (db: Db) => Promise<T>,
  databaseFactory: DatabaseFactory = createDb,
): Promise<T> {
  const db = databaseFactory(databaseUrl);
  try {
    return await operation(db);
  } finally {
    await db.$client.end({ timeout: 0 });
  }
}
