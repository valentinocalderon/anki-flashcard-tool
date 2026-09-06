import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Card } from '@/lib/types';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, conjugationPatterns, words } from '@/server/db/schema';
import { cardedPatternKeys, storeCards } from './cardStore';

const basic: Card = {
  deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
  tags: ['auto-generated', 'vocab'],
};
const example: Card = {
  deck: 'Spanish::Vocab', kind: 'example', front: 'La ____ es grande.',
  back: 'casa (house) (The house is big.)', tags: ['auto-generated'],
};
const present: Card = {
  deck: 'Spanish::Conjugation', kind: 'conjugation',
  front: 'Conjugate hablar in present (regular -ar)',
  back: 'yo: hablo', tags: ['auto-generated'],
};
const preterite: Card = {
  ...present, front: 'Conjugate hablar in preterite (regular -ar)', back: 'yo: hablé',
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
  expect(await storeCards(db, wordId, [basic, example], [])).toEqual({
    vocabCards: 2, conjugationCards: 0,
  });
  expect(await storeCards(db, wordId, [basic, example], [])).toEqual({
    vocabCards: 0, conjugationCards: 0,
  });
  expect(await storeCards(db, wordId, [{ ...basic, deck: 'Another deck' }], [])).toEqual({
    vocabCards: 1, conjugationCards: 0,
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

test('matches claim fronts exactly despite display changes, irregular cards, and reordered claims', async () => {
  const irregular: Card = {
    ...present, front: 'Conjugate ir in present (irregular)', back: 'yo: voy',
  };
  const stemChanging: Card = {
    ...present, front: 'Present forms of querer', back: 'yo: quiero',
  };
  const startedAt = Date.now();
  expect(await storeCards(db, wordId, [basic, irregular, stemChanging, preterite], [
    { front: preterite.front, key: 'ar-regular-preterite' },
    { front: stemChanging.front, key: 'er-e-ie-present' },
  ])).toEqual({ vocabCards: 1, conjugationCards: 3 });

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
  ])).toEqual({ vocabCards: 0, conjugationCards: 1 });

  expect(await db.select().from(cards)).toHaveLength(1);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('claims only the conjugation cards inserted when another card conflicts', async () => {
  await storeCards(db, wordId, [present], []);

  expect(await storeCards(db, wordId, [present, preterite], [
    { front: present.front, key: 'ar-regular-present' },
    { front: preterite.front, key: 'ar-regular-preterite' },
  ])).toEqual({ vocabCards: 0, conjugationCards: 1 });
  expect(await cardedPatternKeys(db)).toEqual(new Set(['ar-regular-preterite']));
  const rows = await db.select().from(cards);
  expect(await db.select().from(conjugationPatterns)).toEqual([
    expect.objectContaining({ cardId: rows.find((row) => row.front === preterite.front)?.id }),
  ]);
});

test('keeps the first pattern claim when a later inserted card claims it again', async () => {
  await storeCards(db, wordId, [present], [{ front: present.front, key: 'ar-regular-present' }]);
  const patterns = await db.select().from(conjugationPatterns);
  const second: Card = { ...present, front: 'Conjugate bailar in present (regular -ar)' };

  expect(await storeCards(db, wordId, [second], [
    { front: second.front, key: 'ar-regular-present' },
  ])).toEqual({
    vocabCards: 0, conjugationCards: 1,
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
  ])).rejects.toHaveProperty('cause.message', expect.stringContaining('pattern insert rejected'));
  expect(await db.select().from(cards)).toEqual([]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test.each(['xx-regular-present', 'ar-irregular-present', 'ar-regular-future', 'ar-regular', 'ar--present'])(
  'rejects an invalid claimed key without storing any cards: %s',
  async (key) => {
    await expect(storeCards(db, wordId, [basic, present], [{ front: present.front, key }])).rejects.toThrow(
      `Invalid conjugation pattern key "${key}"`,
    );
    expect(await db.select().from(cards)).toEqual([]);
    expect(await db.select().from(conjugationPatterns)).toEqual([]);
  },
);

test('rejects a malformed key even when its claim front has no inserted card', async () => {
  await expect(storeCards(db, wordId, [basic], [
    { front: present.front, key: 'ar-regular' },
  ])).rejects.toThrow('Invalid conjugation pattern key "ar-regular"');
  expect(await db.select().from(cards)).toEqual([]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});
