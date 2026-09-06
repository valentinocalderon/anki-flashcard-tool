import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { WordInfo } from "@/lib/types";
import { applyMigrations, createDb, type Db } from "./index";
import { cards, conjugationPatterns, words } from "./schema";

const timestamp = 1_788_696_000_123;
const info: WordInfo = {
  english: "to speak",
  spanish: "hablar",
  gender: null,
  article: null,
  type: "verb",
  example: "Quiero hablar.",
  conjugations: { present: { yo: "hablo" } },
};
const word: typeof words.$inferInsert = {
  query: "hablar",
  info: JSON.stringify(info),
  lookedUpAt: timestamp,
};
const card: typeof cards.$inferInsert = {
  wordId: 1,
  deck: "Spanish::Conjugation",
  kind: "conjugation",
  front: "hablar: yo, present",
  back: "hablo",
  tags: JSON.stringify(["verb", "present"]),
  createdAt: timestamp,
};
const pattern: typeof conjugationPatterns.$inferInsert = {
  ending: "ar",
  pattern: "regular",
  tense: "present",
  cardId: 1,
  createdAt: timestamp,
};

let client: Client;
let db: Db;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  db = createDb(client);
  await applyMigrations(db);
  await db.insert(words).values(word);
  await db.insert(cards).values(card);
  await db.insert(conjugationPatterns).values(pattern);
});

afterEach(() => {
  client.close();
});

test("round-trips JSON text, millisecond timestamps, generated IDs, and nullable send fields", async () => {
  expect(await db.select().from(words)).toEqual([{ id: 1, ...word }]);
  expect(await db.select().from(cards)).toEqual([
    { id: 1, ...card, ankiNoteId: null, sentAt: null },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([
    { id: 1, ...pattern },
  ]);
  await db.update(cards).set({ ankiNoteId: 123_456, sentAt: timestamp + 1 });
  expect(await db.select().from(cards)).toEqual([
    { id: 1, ...card, ankiNoteId: 123_456, sentAt: timestamp + 1 },
  ]);
  const stored = await client.execute("SELECT looked_up_at, info FROM words");
  expect(stored.rows).toEqual([{ looked_up_at: timestamp, info: word.info }]);
});

test("reapplying migrations preserves stored rows and records the migration once", async () => {
  await applyMigrations(db);
  expect(await db.select().from(words)).toEqual([{ id: 1, ...word }]);
  expect(await db.select().from(cards)).toHaveLength(1);
  expect(await db.select().from(conjugationPatterns)).toHaveLength(1);
  expect(
    (await client.execute("SELECT * FROM __drizzle_migrations")).rows,
  ).toHaveLength(1);
});

test("rejects a duplicate normalized word query", async () => {
  await expect(db.insert(words).values(word).run()).rejects.toHaveProperty(
    "cause.message",
    expect.stringContaining("UNIQUE constraint failed"),
  );
});

test("deduplicates card fronts within a deck while allowing another deck or front", async () => {
  await expect(db.insert(cards).values(card).run()).rejects.toHaveProperty(
    "cause.message",
    expect.stringContaining("UNIQUE constraint failed"),
  );
  await db.insert(cards).values({ ...card, deck: "Spanish::Vocab" });
  await db.insert(cards).values({ ...card, front: "hablar: tú, present" });
  expect(await db.select().from(cards)).toHaveLength(3);
});

test("deduplicates conjugation patterns by ending, pattern, and tense together", async () => {
  await expect(
    db.insert(conjugationPatterns).values(pattern).run(),
  ).rejects.toHaveProperty(
    "cause.message",
    expect.stringContaining("UNIQUE constraint failed"),
  );
  await db.insert(conjugationPatterns).values({ ...pattern, ending: "er" });
  await db.insert(conjugationPatterns).values({ ...pattern, pattern: "e-ie" });
  await db
    .insert(conjugationPatterns)
    .values({ ...pattern, tense: "preterite" });
  expect(await db.select().from(conjugationPatterns)).toHaveLength(4);
});

test("rejects orphan cards and conjugation patterns", async () => {
  await expect(
    db
      .insert(cards)
      .values({ ...card, wordId: 999, front: "orphan" })
      .run(),
  ).rejects.toHaveProperty(
    "cause.message",
    expect.stringContaining("FOREIGN KEY constraint failed"),
  );
  await expect(
    db
      .insert(conjugationPatterns)
      .values({ ...pattern, cardId: 999, ending: "ir" })
      .run(),
  ).rejects.toHaveProperty(
    "cause.message",
    expect.stringContaining("FOREIGN KEY constraint failed"),
  );
});

test("rejects null required fields in each table", async () => {
  await expect(client.execute("UPDATE words SET info = NULL")).rejects.toThrow(
    "NOT NULL constraint failed",
  );
  await expect(client.execute("UPDATE cards SET tags = NULL")).rejects.toThrow(
    "NOT NULL constraint failed",
  );
  await expect(
    client.execute("UPDATE conjugation_patterns SET created_at = NULL"),
  ).rejects.toThrow("NOT NULL constraint failed");
});
