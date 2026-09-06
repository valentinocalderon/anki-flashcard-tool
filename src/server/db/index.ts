import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { loadConfig } from "@/lib/config";
import * as schema from "./schema";

export function createDb(client: Client) {
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

export function applyMigrations(db: Db): Promise<void> {
  return migrate(db, { migrationsFolder: "drizzle" });
}

let dbPromise: Promise<Db> | undefined;

export function getDb(): Promise<Db> {
  dbPromise ??= (async () => {
    const client = createClient({ url: loadConfig().database.url });
    const db = createDb(client);
    await applyMigrations(db);
    return db;
  })();
  return dbPromise;
}
