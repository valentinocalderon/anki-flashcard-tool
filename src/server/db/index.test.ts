import { createClient } from "@libsql/client";
import type * as Libsql from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import type * as LibsqlMigrator from "drizzle-orm/libsql/migrator";
import { afterEach, expect, test, vi } from "vitest";
import { configSchema, loadConfig } from "@/lib/config";
import { getDb, type Db } from "./index";

vi.mock("@libsql/client", async (importOriginal) => {
  const original = await importOriginal<typeof Libsql>();
  return {
    ...original,
    createClient: vi.fn(() => original.createClient({ url: ":memory:" })),
  };
});

vi.mock("drizzle-orm/libsql/migrator", async (importOriginal) => {
  const original = await importOriginal<typeof LibsqlMigrator>();
  return { ...original, migrate: vi.fn(original.migrate) };
});

afterEach(() => {
  for (const result of vi.mocked(createClient).mock.results) {
    if (result.type === "return") {
      result.value.close();
    }
  }
});

test("requires a typed database URL and configures the locked SQLite file", () => {
  expect(configSchema.parse(loadConfig()).database).toEqual({
    url: "file:db.sqlite",
  });
  expect(
    configSchema.safeParse({ ...loadConfig(), database: undefined }).success,
  ).toBe(false);
  expect(
    configSchema.safeParse({ ...loadConfig(), database: { url: 123 } }).success,
  ).toBe(false);
});

test("shares one initialization promise and migrates before returning the database", async () => {
  let releaseMigration: () => void = () => {
    throw new Error(
      "Migration gate was not initialized; create the gate before releasing it.",
    );
  };
  const migrationGate = new Promise<void>((resolve) => {
    releaseMigration = resolve;
  });
  const original = await vi.importActual<typeof LibsqlMigrator>(
    "drizzle-orm/libsql/migrator",
  );
  vi.mocked(migrate).mockImplementationOnce(async (db, options) => {
    await migrationGate;
    await original.migrate(db, options);
  });

  const first: Promise<Db> = getDb();
  expect(getDb()).toBe(first);
  expect(createClient).toHaveBeenCalledExactlyOnceWith({
    url: "file:db.sqlite",
  });
  let resolved = false;
  const observation = first.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);

  releaseMigration();
  const db = await first;
  await observation;
  expect(getDb()).toBe(first);
  expect(await getDb()).toBe(db);
  expect(migrate).toHaveBeenCalledExactlyOnceWith(db, {
    migrationsFolder: "drizzle",
  });
  expect(await db.query.words.findMany()).toEqual([]);
  expect(await db.query.cards.findMany()).toEqual([]);
  expect(await db.query.conjugationPatterns.findMany()).toEqual([]);
});
