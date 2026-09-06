import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WordInfo } from '@/lib/types';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, conjugationPatterns, words } from '@/server/db/schema';
import * as cardGenerator from './cardGenerator';
import { generateForWords, parseWordList, type WordResult } from './listGenerationService';

const noun: WordInfo = {
  english: 'house', spanish: 'casa', gender: 'feminine', article: 'la', type: 'noun',
  example: 'La casa es grande. (The house is big.)', conjugations: null,
};
const regularVerb: WordInfo = {
  english: 'to speak', spanish: 'hablar', gender: null, article: null, type: 'verb',
  example: null,
  conjugations: {
    present: {
      yo: 'hablo', tú: 'hablas', 'él/ella': 'habla',
      nosotros: 'hablamos', vosotros: 'habláis', ellos: 'hablan',
    },
    preterite: {
      yo: 'hablé', tú: 'hablaste', 'él/ella': 'habló',
      nosotros: 'hablamos', vosotros: 'hablasteis', ellos: 'hablaron',
    },
  },
  conjugationClass: { ending: 'ar', present: 'regular', preterite: 'regular' },
};
const secondRegularVerb: WordInfo = {
  ...regularVerb, english: 'to dance', spanish: 'bailar',
  conjugations: {
    present: {
      yo: 'bailo', tú: 'bailas', 'él/ella': 'baila',
      nosotros: 'bailamos', vosotros: 'bailáis', ellos: 'bailan',
    },
    preterite: {
      yo: 'bailé', tú: 'bailaste', 'él/ella': 'bailó',
      nosotros: 'bailamos', vosotros: 'bailasteis', ellos: 'bailaron',
    },
  },
};
const irregularVerb: WordInfo = {
  ...regularVerb, english: 'to go', spanish: 'ir',
  conjugations: {
    present: {
      yo: 'voy', tú: 'vas', 'él/ella': 'va',
      nosotros: 'vamos', vosotros: 'vais', ellos: 'van',
    },
    preterite: {
      yo: 'fui', tú: 'fuiste', 'él/ella': 'fue',
      nosotros: 'fuimos', vosotros: 'fuisteis', ellos: 'fueron',
    },
  },
  conjugationClass: { ending: 'ir', present: 'irregular', preterite: 'irregular' },
};

let client: Client;
let db: Db;

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  db = createDb(client);
  await applyMigrations(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});

test('parses lines, trims blanks, and deduplicates case-insensitively keeping first spelling and order', () => {
  expect(parseWordList('  Casa \r\n\n HABLAR\r casa\nhablar\n árbol \nÁRBOL\npor favor  ')).toEqual([
    'Casa', 'HABLAR', 'árbol', 'por favor',
  ]);
  expect(parseWordList(' \r\n\t\n')).toEqual([]);
});

test('an empty list produces no results or lookups', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect(await generateForWords(db, ' \n\t ', lookup)).toEqual([]);
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([]);
});

test('adds a noun and its example once, then reports exists using the normalized cache', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);
  const first: WordResult[] = await generateForWords(db, ' Casa \nCASA\n', lookup);

  expect(first).toEqual([{ word: 'Casa', status: 'added', vocabCards: 2, conjugationCards: 0 }]);
  expect(await generateForWords(db, 'casa', lookup)).toEqual([
    { word: 'casa', status: 'exists', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup).toHaveBeenCalledExactlyOnceWith('Casa');
  const storedWords = await db.select().from(words);
  expect(storedWords).toEqual([expect.objectContaining({ query: 'casa' })]);
  const storedCards = await db.select().from(cards).orderBy(cards.id);
  expect(storedCards).toHaveLength(2);
  expect(storedCards[0]).toMatchObject({
    wordId: storedWords[0]?.id, kind: 'basic', front: 'house', back: 'la casa',
  });
  expect(storedCards[1]).toMatchObject({
    wordId: storedWords[0]?.id, kind: 'example', front: 'La ____ es grande.',
  });
});

test('finishes storing the first regular verb before looking up the next verb of that pattern', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();
  lookup.mockImplementationOnce(async (word) => {
    expect(word).toBe('hablar');
    expect(await db.select().from(cards)).toHaveLength(0);
    return regularVerb;
  });
  lookup.mockImplementationOnce(async (word) => {
    expect(word).toBe('bailar');
    expect(await db.select().from(cards)).toHaveLength(3);
    expect(await db.select().from(conjugationPatterns)).toHaveLength(2);
    return secondRegularVerb;
  });

  expect(await generateForWords(db, 'hablar\nbailar', lookup)).toEqual([
    { word: 'hablar', status: 'added', vocabCards: 1, conjugationCards: 2 },
    { word: 'bailar', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['hablar'], ['bailar']]);
  expect(await db.select().from(cards)).toHaveLength(4);
  expect(await db.select().from(conjugationPatterns)).toHaveLength(2);
  expect(await generateForWords(db, 'hablar\nbailar', lookup)).toEqual([
    { word: 'hablar', status: 'exists', vocabCards: 0, conjugationCards: 0 },
    { word: 'bailar', status: 'exists', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup).toHaveBeenCalledTimes(2);
});

test('adds both irregular tenses without pattern claims and reports exists on repeat', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(irregularVerb);

  expect(await generateForWords(db, 'ir', lookup)).toEqual([
    { word: 'ir', status: 'added', vocabCards: 1, conjugationCards: 2 },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  expect((await db.select().from(cards).orderBy(cards.id)).map((card) => card.front)).toEqual([
    'to go', 'Conjugate ir in present (irregular)', 'Conjugate ir in preterite (irregular)',
  ]);
  expect(await generateForWords(db, 'IR', lookup)).toEqual([
    { word: 'IR', status: 'exists', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup).toHaveBeenCalledTimes(1);
});

test('reports an error payload without storing it and continues with the following word', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce({ ...noun, spanish: 'unsupported', error: 'Word not supported' })
    .mockResolvedValueOnce(noun);

  expect(await generateForWords(db, 'unsupported\ncasa', lookup)).toEqual([
    { word: 'unsupported', status: 'error', vocabCards: 0, conjugationCards: 0, message: 'Word not supported' },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['unsupported'], ['casa']]);
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
  expect(await db.select().from(cards)).toHaveLength(2);
});

test('reports a storage error, rolls back the word, and continues with the following word', async () => {
  await client.execute(`
    CREATE TRIGGER reject_preterite_card BEFORE INSERT ON cards
    WHEN NEW.front = 'Conjugate hablar in preterite (regular -ar)'
    BEGIN SELECT RAISE(ABORT, 'card insert rejected'); END
  `);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(regularVerb)
    .mockResolvedValueOnce(noun);

  const results = await generateForWords(db, 'hablar\ncasa', lookup);
  expect(results).toEqual([
    expect.objectContaining({
      word: 'hablar', status: 'error', vocabCards: 0, conjugationCards: 0,
    }),
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(results[0]?.message).toContain('insert into "cards"');
  expect(lookup.mock.calls).toEqual([['hablar'], ['casa']]);
  expect((await db.select().from(cards).orderBy(cards.id)).map((card) => card.front)).toEqual([
    'house', 'La ____ es grande.',
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('reports a generation error and continues with the following word', async () => {
  vi.spyOn(cardGenerator, 'generateCards').mockImplementationOnce(() => {
    throw new Error('Card generation failed; check word data and retry.');
  });
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(regularVerb)
    .mockResolvedValueOnce(noun);

  expect(await generateForWords(db, 'hablar\ncasa', lookup)).toEqual([
    {
      word: 'hablar', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Card generation failed; check word data and retry.',
    },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['hablar'], ['casa']]);
  expect(await db.select().from(cards)).toHaveLength(2);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('reports a missing cached word row and continues with the following word', async () => {
  await client.execute(`
    CREATE TRIGGER remove_missing_word AFTER INSERT ON words
    WHEN NEW.query = 'missing'
    BEGIN DELETE FROM words WHERE id = NEW.id; END
  `);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);

  expect(await generateForWords(db, 'missing\ncasa', lookup)).toEqual([
    {
      word: 'missing', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Cached word "missing" is missing; check lookup cache persistence and retry.',
    },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['missing'], ['casa']]);
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
  expect(await db.select().from(cards)).toHaveLength(2);
});

test.each([new Error('Lookup unavailable; retry later'), 'Lookup unavailable; retry later'])(
  'reports a thrown lookup error and still generates the following word: %s',
  async (error) => {
    const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(noun);

    expect(await generateForWords(db, 'broken\ncasa', lookup)).toEqual([
      {
        word: 'broken', status: 'error', vocabCards: 0, conjugationCards: 0,
        message: 'Lookup unavailable; retry later',
      },
      { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
    ]);
    expect(lookup.mock.calls).toEqual([['broken'], ['casa']]);
    expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
    expect(await db.select().from(cards)).toHaveLength(2);
  },
);
