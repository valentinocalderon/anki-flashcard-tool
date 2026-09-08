import {
  blob,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const words = sqliteTable("words", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  query: text("query").notNull().unique(),
  info: text("info").notNull(),
  lookedUpAt: integer("looked_up_at").notNull(),
});

export const cards = sqliteTable(
  "cards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wordId: integer("word_id")
      .notNull()
      .references(() => words.id),
    deck: text("deck").notNull(),
    kind: text("kind").$type<"basic" | "example" | "conjugation">().notNull(),
    front: text("front").notNull(),
    back: text("back").notNull(),
    tags: text("tags").notNull(),
    forms: text("forms", { mode: "json" }).$type<{ spanish: string; query: string }[]>(),
    audioFile: text("audio_file"),
    audioMp3: blob("audio_mp3", { mode: "buffer" }),
    ankiNoteId: integer("anki_note_id"),
    sentAt: integer("sent_at"),
    declinedAt: integer("declined_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("cards_deck_front_unique").on(table.deck, table.front),
  ],
);

export const conjugationPatterns = sqliteTable(
  "conjugation_patterns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ending: text("ending").$type<"ar" | "er" | "ir">().notNull(),
    pattern: text("pattern")
      .$type<"regular" | "e-ie" | "o-ue" | "e-i" | "u-ue">()
      .notNull(),
    tense: text("tense").$type<"present" | "preterite">().notNull(),
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("conjugation_patterns_ending_pattern_tense_unique").on(
      table.ending,
      table.pattern,
      table.tense,
    ),
  ],
);
