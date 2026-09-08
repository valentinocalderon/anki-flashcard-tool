import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, conjugationPatterns, words } from '@/server/db/schema';
import type { GeneratedCard } from './cardGenerator';
import { cardedPatternKeys, storeCards } from './cardStore';

const basic: GeneratedCard = {
  deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
  tags: ['auto-generated', 'vocab'],
};
const example: GeneratedCard = {
  deck: 'Spanish::Vocab', kind: 'example', front: 'La ____ es grande.',
  back: 'casa (house) (The house is big.)', tags: ['auto-generated'],
};
const present: GeneratedCard = {
  deck: 'Spanish::Conjugation', kind: 'conjugation',
  front: 'Conjugate hablar in present (regular -ar)',
  back: 'yo: hablo', tags: ['auto-generated'],
};
const preterite: GeneratedCard = {
  ...present, front: 'Conjugate hablar in preterite (regular -ar)', back: 'yo: hablé',
};
const folded: GeneratedCard = {
  deck: 'Spanish::Vocab', kind: 'basic', front: 'goodbye', back: '¡Adiós! / ¡Chao!',
  tags: ['auto-generated'], forms: [
    { spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' },
  ],
};
const storedGoodbye: typeof cards.$inferSelect = {
  id: 41, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'goodbye', back: '¡Adiós!',
  tags: '["original"]', ankiNoteId: 987654, sentAt: 456, declinedAt: null, createdAt: 123,
};

let client: Client;
let db: Db;
let wordId: number;

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  db = createDb(client);
  await applyMigrations(db);
  const word = await db.insert(words).values({
    query: 'test', info: '{}', lookedUpAt: Date.now(),
  }).returning({ id: words.id }).get();
  wordId = word.id;
});

afterEach(() => {
  client.close();
});

test('reads existing pattern rows into ending-pattern-tense keys', async () => {
  expect(await cardedPatternKeys(db)).toEqual(new Set());
  const card = await db.insert(cards).values({
    ...present, wordId, tags: JSON.stringify(present.tags), createdAt: Date.now(),
  }).returning({ id: cards.id }).get();
  await db.insert(conjugationPatterns).values([
    { ending: 'ar', pattern: 'regular', tense: 'preterite', cardId: card.id, createdAt: Date.now() },
    { ending: 'er', pattern: 'e-ie', tense: 'present', cardId: card.id, createdAt: Date.now() },
  ]);

  expect(await cardedPatternKeys(db)).toEqual(new Set(['ar-regular-preterite', 'er-e-ie-present']));
});

test('stores vocabulary fields and counts only cards newly inserted per card kind', async () => {
  const startedAt = Date.now();
  expect(await storeCards(db, wordId, [basic, example], [], false, [wordId])).toEqual({
    vocabCards: 2, conjugationCards: 0, updatedCards: 0,
  });
  expect(await storeCards(db, wordId, [basic, example], [], false, [wordId])).toEqual({
    vocabCards: 0, conjugationCards: 0, updatedCards: 0,
  });
  expect(await storeCards(db, wordId, [{ ...basic, deck: 'Another deck' }], [], false, [wordId])).toEqual({
    vocabCards: 1, conjugationCards: 0, updatedCards: 0,
  });
  const rows = await db.select().from(cards).orderBy(cards.id);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({
    ...basic, wordId, tags: JSON.stringify(basic.tags), ankiNoteId: null, sentAt: null,
  });
  expect(rows[1]).toMatchObject({ ...example, wordId, tags: JSON.stringify(example.tags) });
  for (const row of rows) {
    expect(row.createdAt).toBeGreaterThanOrEqual(startedAt);
    expect(row.createdAt).toBeLessThanOrEqual(Date.now());
  }
  expect(await cardedPatternKeys(db)).toEqual(new Set());
});

test.each([false, true])('stores a folded card without a forms column when partly carded is %s', async (partlyCarded) => {
  const generated: readonly GeneratedCard[] = [folded];

  expect(await storeCards(db, wordId, generated, [], partlyCarded, [wordId])).toEqual({
    vocabCards: 1, conjugationCards: 0, updatedCards: 0,
  });
  expect(await db.select().from(cards)).toEqual([expect.objectContaining({
    id: 1, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'goodbye', back: '¡Adiós! / ¡Chao!',
    tags: '["auto-generated"]', ankiNoteId: null, sentAt: null, declinedAt: null,
  })]);
  expect((await client.execute('PRAGMA table_info(cards)')).rows.map((row) => row.name)).toEqual([
    'id', 'word_id', 'deck', 'kind', 'front', 'back', 'tags', 'anki_note_id', 'sent_at', 'created_at', 'declined_at',
  ]);
});

test('updates a collision owned by the second form, retaining all stored identity and metadata', async () => {
  await db.insert(words).values([
    { id: 2, query: '¡adiós!', info: '{}', lookedUpAt: 123 },
    { id: 3, query: '¡chao!', info: '{}', lookedUpAt: 123 },
  ]);
  await db.insert(cards).values({ ...storedGoodbye, wordId: 3, back: '¡Chao!' });

  expect(await storeCards(db, 2, [folded], [], true, [2, 3])).toEqual({
    vocabCards: 0, conjugationCards: 0, updatedCards: 1,
  });
  expect(await db.select().from(cards)).toEqual([{ ...storedGoodbye, wordId: 3, back: '¡Adiós! / ¡Chao!' }]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('leaves an unrelated word collision untouched and does not report an update', async () => {
  await db.insert(words).values([
    { id: 2, query: 'el carro', info: '{}', lookedUpAt: 123 },
    { id: 3, query: 'el auto', info: '{}', lookedUpAt: 123 },
    { id: 4, query: 'el coche', info: '{}', lookedUpAt: 123 },
  ]);
  const storedCar = { ...storedGoodbye, wordId: 4, front: 'the car', back: 'el coche' };
  await db.insert(cards).values(storedCar);
  const foldedCar: GeneratedCard = {
    ...folded, front: 'the car', back: 'el carro / el auto', forms: [
      { spanish: 'el carro', query: 'el carro' }, { spanish: 'el auto', query: 'el auto' },
    ],
  };

  expect(await storeCards(db, 2, [foldedCar], [], true, [2, 3])).toEqual({
    vocabCards: 0, conjugationCards: 0, updatedCards: 0,
  });
  expect(await db.select().from(cards)).toEqual([storedCar]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('leaves a differing back untouched when the item is not partly carded', async () => {
  await db.insert(cards).values(storedGoodbye);

  expect(await storeCards(db, wordId, [folded], [], false, [wordId])).toEqual({
    vocabCards: 0, conjugationCards: 0, updatedCards: 0,
  });
  expect(await db.select().from(cards)).toEqual([storedGoodbye]);
});

test.each([
  { name: 'basic', card: basic },
  { name: 'example', card: example },
  { name: 'conjugation', card: present },
  { name: 'empty forms', card: { ...basic, forms: [] } },
  { name: 'single form', card: { ...basic, forms: [{ spanish: 'casa', query: 'casa' }] } },
])('keeps conflict-do-nothing for a partly carded item with an unfolded $name card', async ({ card }) => {
  await storeCards(db, wordId, [card], [], false, [wordId]);

  expect(await storeCards(db, wordId, [{ ...card, back: 'changed answer' }], [], true, [wordId])).toEqual({
    vocabCards: 0, conjugationCards: 0, updatedCards: 0,
  });
  expect(await db.select({ back: cards.back }).from(cards)).toEqual([{ back: card.back }]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('does not issue an update or count one when a partly carded item has an identical back', async () => {
  await db.insert(cards).values({ ...storedGoodbye, back: '¡Adiós! / ¡Chao!' });
  await client.execute(`
    CREATE TRIGGER reject_card_update BEFORE UPDATE ON cards
    BEGIN SELECT RAISE(ABORT, 'unexpected card update'); END
  `);

  expect(await storeCards(db, wordId, [folded], [], true, [wordId])).toEqual({
    vocabCards: 0, conjugationCards: 0, updatedCards: 0,
  });
  expect(await db.select().from(cards)).toEqual([{ ...storedGoodbye, back: '¡Adiós! / ¡Chao!' }]);
});

test('counts an enrichment separately from inserted cards and claims only inserted conjugations', async () => {
  await db.insert(cards).values(storedGoodbye);
  await storeCards(db, wordId, [present], [], false, [wordId]);

  expect(await storeCards(db, wordId, [folded, basic, present, preterite], [
    { front: present.front, key: 'ar-regular-present' },
    { front: preterite.front, key: 'ar-regular-preterite' },
  ], true, [wordId])).toEqual({ vocabCards: 1, conjugationCards: 1, updatedCards: 1 });
  expect((await db.select().from(cards).orderBy(cards.id)).map(({ front, back }) => ({ front, back }))).toEqual([
    { front: 'goodbye', back: '¡Adiós! / ¡Chao!' },
    { front: 'Conjugate hablar in present (regular -ar)', back: 'yo: hablo' },
    { front: 'house', back: 'la casa' },
    { front: 'Conjugate hablar in preterite (regular -ar)', back: 'yo: hablé' },
  ]);
  expect(await cardedPatternKeys(db)).toEqual(new Set(['ar-regular-preterite']));
});

test('propagates an update failure and rolls back new cards without changing the stored note', async () => {
  await db.insert(cards).values(storedGoodbye);
  await client.execute(`
    CREATE TRIGGER reject_card_update BEFORE UPDATE ON cards
    BEGIN SELECT RAISE(ABORT, 'card update rejected'); END
  `);

  await expect(storeCards(db, wordId, [basic, folded], [], true, [wordId]))
    .rejects.toHaveProperty('cause.message', expect.stringContaining('card update rejected'));
  expect(await db.select().from(cards)).toEqual([storedGoodbye]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('rolls back an enrichment and new cards when a later pattern claim fails', async () => {
  await db.insert(cards).values(storedGoodbye);
  await client.execute(`
    CREATE TRIGGER reject_preterite BEFORE INSERT ON conjugation_patterns
    WHEN NEW.tense = 'preterite'
    BEGIN SELECT RAISE(ABORT, 'pattern insert rejected'); END
  `);

  await expect(storeCards(db, wordId, [folded, present, preterite], [
    { front: present.front, key: 'ar-regular-present' },
    { front: preterite.front, key: 'ar-regular-preterite' },
  ], true, [wordId])).rejects.toHaveProperty('cause.message', expect.stringContaining('pattern insert rejected'));
  expect(await db.select().from(cards)).toEqual([storedGoodbye]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('matches claim fronts exactly despite display changes, irregular cards, and reordered claims', async () => {
  const irregular: GeneratedCard = {
    ...present, front: 'Conjugate ir in present (irregular)', back: 'yo: voy',
  };
  const stemChanging: GeneratedCard = {
    ...present, front: 'Present forms of querer', back: 'yo: quiero',
  };
  const startedAt = Date.now();
  expect(await storeCards(db, wordId, [basic, irregular, stemChanging, preterite], [
    { front: preterite.front, key: 'ar-regular-preterite' },
    { front: stemChanging.front, key: 'er-e-ie-present' },
  ], false, [wordId])).toEqual({ vocabCards: 1, conjugationCards: 3, updatedCards: 0 });

  const rows = await db.select().from(cards);
  const patterns = await db.select().from(conjugationPatterns).orderBy(conjugationPatterns.id);
  expect(patterns).toHaveLength(2);
  expect(patterns[0]).toMatchObject({
    ending: 'er', pattern: 'e-ie', tense: 'present',
    cardId: rows.find((row) => row.front === stemChanging.front)?.id,
  });
  expect(patterns[1]).toMatchObject({
    ending: 'ar', pattern: 'regular', tense: 'preterite',
    cardId: rows.find((row) => row.front === preterite.front)?.id,
  });
  for (const pattern of patterns) {
    expect(pattern.createdAt).toBeGreaterThanOrEqual(startedAt);
    expect(pattern.createdAt).toBeLessThanOrEqual(Date.now());
  }
});

test('does not record a claim for a different front with the same display suffix', async () => {
  expect(await storeCards(db, wordId, [present], [
    { front: 'Conjugate bailar in present (regular -ar)', key: 'ar-regular-present' },
  ], false, [wordId])).toEqual({ vocabCards: 0, conjugationCards: 1, updatedCards: 0 });

  expect(await db.select().from(cards)).toHaveLength(1);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('claims only the conjugation cards inserted when another card conflicts', async () => {
  await storeCards(db, wordId, [present], [], false, [wordId]);

  expect(await storeCards(db, wordId, [present, preterite], [
    { front: present.front, key: 'ar-regular-present' },
    { front: preterite.front, key: 'ar-regular-preterite' },
  ], false, [wordId])).toEqual({ vocabCards: 0, conjugationCards: 1, updatedCards: 0 });
  expect(await cardedPatternKeys(db)).toEqual(new Set(['ar-regular-preterite']));
  const rows = await db.select().from(cards);
  expect(await db.select().from(conjugationPatterns)).toEqual([
    expect.objectContaining({ cardId: rows.find((row) => row.front === preterite.front)?.id }),
  ]);
});

test('keeps the first pattern claim when a later inserted card claims it again', async () => {
  await storeCards(db, wordId, [present], [{ front: present.front, key: 'ar-regular-present' }], false, [wordId]);
  const patterns = await db.select().from(conjugationPatterns);
  const second: GeneratedCard = { ...present, front: 'Conjugate bailar in present (regular -ar)' };

  expect(await storeCards(db, wordId, [second], [
    { front: second.front, key: 'ar-regular-present' },
  ], false, [wordId])).toEqual({
    vocabCards: 0, conjugationCards: 1, updatedCards: 0,
  });
  expect(await db.select().from(conjugationPatterns)).toEqual(patterns);
});

test('rolls back all cards and claims for a word when a later pattern insert fails', async () => {
  await client.execute(`
    CREATE TRIGGER reject_preterite BEFORE INSERT ON conjugation_patterns
    WHEN NEW.tense = 'preterite'
    BEGIN SELECT RAISE(ABORT, 'pattern insert rejected'); END
  `);

  await expect(storeCards(db, wordId, [basic, present, preterite], [
    { front: present.front, key: 'ar-regular-present' },
    { front: preterite.front, key: 'ar-regular-preterite' },
  ], false, [wordId])).rejects.toHaveProperty('cause.message', expect.stringContaining('pattern insert rejected'));
  expect(await db.select().from(cards)).toEqual([]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test.each(['xx-regular-present', 'ar-irregular-present', 'ar-regular-future', 'ar-regular', 'ar--present'])(
  'rejects an invalid claimed key without storing any cards: %s',
  async (key) => {
    await expect(storeCards(db, wordId, [basic, present], [{ front: present.front, key }], false, [wordId])).rejects.toThrow(
      `Invalid conjugation pattern key "${key}"`,
    );
    expect(await db.select().from(cards)).toEqual([]);
    expect(await db.select().from(conjugationPatterns)).toEqual([]);
  },
);

test('rejects a malformed key even when its claim front has no inserted card', async () => {
  await expect(storeCards(db, wordId, [basic], [
    { front: present.front, key: 'ar-regular' },
  ], false, [wordId])).rejects.toThrow('Invalid conjugation pattern key "ar-regular"');
  expect(await db.select().from(cards)).toEqual([]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});
