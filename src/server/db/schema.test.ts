import { createClient, type Client } from "@libsql/client";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

async function useEarlierMigrations(count: number) {
  client.close();
  client = createClient({ url: ":memory:" });
  db = createDb(client);
  await client.execute(`CREATE TABLE __drizzle_migrations (
    id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric
  )`);
  for (const migration of readMigrationFiles({ migrationsFolder: "drizzle" }).slice(0, count)) {
    for (const statement of migration.sql) await client.execute(statement);
    await client.execute({
      sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      args: [migration.hash, migration.folderMillis],
    });
  }
}

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
    { id: 1, ...card, forms: null, audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: null, sentAt: null, declinedAt: null },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([
    { id: 1, ...pattern },
  ]);
  await db.update(cards).set({ ankiNoteId: 123_456, sentAt: timestamp + 1 });
  expect(await db.select().from(cards)).toEqual([
    { id: 1, ...card, forms: null, audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: 123_456, sentAt: timestamp + 1, declinedAt: null },
  ]);
  const stored = await client.execute("SELECT looked_up_at, info FROM words");
  expect(stored.rows).toEqual([{ looked_up_at: timestamp, info: word.info }]);
});

test("migrates cards with a nullable JSON text forms column and no default", async () => {
  expect((await client.execute("PRAGMA table_info(cards)")).rows).toContainEqual(
    expect.objectContaining({ name: "forms", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }),
  );
});

test("migrates cards with nullable text audio_file and blob audio_mp3 columns", async () => {
  expect((await client.execute("PRAGMA table_info(cards)")).rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "audio_file", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }),
      expect.objectContaining({ name: "audio_mp3", type: "BLOB", notnull: 0, dflt_value: null, pk: 0 }),
    ]),
  );
});

test("migrates cards with a nullable integer audio_sent_at column and no default", async () => {
  const columns = (await client.execute("PRAGMA table_info(cards)")).rows;
  expect(columns.find((column) => column.name === "audio_sent_at")).toMatchObject({
    name: "audio_sent_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0,
  });
  expect(await db.select().from(cards)).toMatchObject([{ audioSentAt: null }]);

  await client.execute("UPDATE cards SET audio_sent_at = 1788696000124");
  expect(await db.select().from(cards)).toMatchObject([{ audioSentAt: 1_788_696_000_124 }]);

  await client.execute("UPDATE cards SET audio_sent_at = NULL");
  expect(await db.select().from(cards)).toMatchObject([{ audioSentAt: null }]);
});

test("accepts omitted and explicit null audio fields for cards without audio", async () => {
  await db.insert(cards).values({
    ...card,
    front: "without audio",
    audioFile: null,
    audioMp3: null,
  });

  expect(await db.select().from(cards).orderBy(cards.id)).toMatchObject([
    { id: 1, audioFile: null, audioMp3: null },
    { id: 2, audioFile: null, audioMp3: null },
  ]);
});

test("round-trips the Anki media filename and mp3 bytes on their own card row", async () => {
  await db.insert(cards).values({
    ...card,
    front: "with audio",
    audioFile: "card-2.mp3",
    audioMp3: Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x80, 0x00]),
  });

  expect(await db.select().from(cards).orderBy(cards.id)).toMatchObject([
    { id: 1, audioFile: null, audioMp3: null },
    { id: 2, audioFile: "card-2.mp3", audioMp3: Buffer.from("49443300fffb90648000", "hex") },
  ]);
  expect((await client.execute(`SELECT audio_file, typeof(audio_mp3) AS storage_type,
    hex(audio_mp3) AS bytes FROM cards WHERE id = 2`)).rows).toEqual([
    { audio_file: "card-2.mp3", storage_type: "blob", bytes: "49443300FFFB90648000" },
  ]);
});

test("adds forms to an existing card as null without rewriting its stored fields", async () => {
  await useEarlierMigrations(3);
  await db.insert(words).values(word);
  await client.execute({
    sql: `INSERT INTO cards
      (id, word_id, deck, kind, front, back, tags, anki_note_id, sent_at, declined_at, created_at)
      VALUES (41, 1, 'Spanish::Conjugation', 'conjugation', 'hablar: yo, present', 'hablo',
        '["verb","present"]', 123456, ?, NULL, ?)`,
    args: [timestamp + 1, timestamp],
  });
  await client.execute(`CREATE TRIGGER reject_card_update BEFORE UPDATE ON cards
    BEGIN SELECT RAISE(ABORT, 'unexpected legacy card rewrite'); END`);

  await applyMigrations(db);

  expect(await db.select().from(cards)).toEqual([
    { id: 41, ...card, forms: null, audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: 123_456, sentAt: timestamp + 1, declinedAt: null },
  ]);
  expect((await client.execute("SELECT forms FROM cards")).rows).toEqual([{ forms: null }]);
});

test("reapplying migrations preserves stored rows and records each migration once", async () => {
  await applyMigrations(db);
  expect(await db.select().from(words)).toEqual([{ id: 1, ...word }]);
  expect(await db.select().from(cards)).toHaveLength(1);
  expect(await db.select().from(conjugationPatterns)).toHaveLength(1);
  expect(
    (await client.execute("SELECT * FROM __drizzle_migrations")).rows,
  ).toHaveLength(6);
});

test("backfills old-style declines without changing sent or pending cards", async () => {
  await useEarlierMigrations(2);
  await db.insert(words).values(word);
  await client.execute({
    sql: `INSERT INTO cards (word_id, deck, kind, front, back, tags, anki_note_id, sent_at, created_at)
      VALUES (1, 'Spanish::Conjugation', 'conjugation', 'hablar: yo, present', 'hablo',
        '["verb","present"]', NULL, ?, ?),
      (1, 'Spanish::Conjugation', 'conjugation', 'sent', 'hablo', '["verb","present"]', 123456, ?, ?),
      (1, 'Spanish::Conjugation', 'conjugation', 'pending', 'hablo', '["verb","present"]', NULL, NULL, ?)`,
    args: [timestamp + 1, timestamp, timestamp + 2, timestamp, timestamp],
  });

  await applyMigrations(db);

  expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
    { id: 1, ...card, forms: null, audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: null, sentAt: null, declinedAt: timestamp + 1 },
    { id: 2, ...card, front: "sent", forms: null, audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: 123_456, sentAt: timestamp + 2, declinedAt: null },
    { id: 3, ...card, front: "pending", forms: null, audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: null, sentAt: null, declinedAt: null },
  ]);
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
