import { createClient } from "@libsql/client";
import type * as Libsql from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, expect, test, vi } from "vitest";
import { getDb } from "./index";

vi.mock("@libsql/client", async (importOriginal) => {
  const original = await importOriginal<typeof Libsql>();
  return {
    ...original,
    createClient: vi.fn(() => original.createClient({ url: ":memory:" })),
  };
});

vi.mock("drizzle-orm/libsql/migrator", () => ({
  migrate: vi.fn<typeof migrate>(),
}));

afterEach(() => {
  for (const result of vi.mocked(createClient).mock.results) {
    if (result.type === "return") {
      result.value.close();
    }
  }
});

test("propagates migration failures and retains the rejected initialization promise", async () => {
  const failure = new Error(
    "Migration failed: repair drizzle migrations before restarting.",
  );
  vi.mocked(migrate).mockRejectedValueOnce(failure);
  const first = getDb();
  await expect(first).rejects.toBe(failure);
  expect(getDb()).toBe(first);
  await expect(getDb()).rejects.toBe(failure);
  expect(createClient).toHaveBeenCalledTimes(1);
  expect(migrate).toHaveBeenCalledTimes(1);
});
