import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WordInfo, WordResult } from '@/lib/types';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, conjugationPatterns, words } from '@/server/db/schema';
import { askForJson } from './aiLookup';
import { spanishSideItems } from './brainscapeSides';
import * as cardGenerator from './cardGenerator';
import { dedupeItems, generateForWords } from './listGenerationService';
import * as lookupCache from './lookupCache';
import * as wordListParser from './wordListParser';

vi.mock('@/env', () => ({ env: { OPENAI_API_KEY: 'test-key' } }));
vi.mock('./aiLookup', () => ({
  askForJson: vi.fn<typeof askForJson>().mockRejectedValue(new Error('Unexpected extraction request')),
}));

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
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Unexpected global fetch; tests must use lookup doubles.');
  }));
  client = createClient({ url: ':memory:' });
  db = createDb(client);
  await applyMigrations(db);
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  client.close();
  expect(askForJson).not.toHaveBeenCalled();
});

test('dedupes normalized forms within and across items while preserving alternative groups', () => {
  const items = [
    ' ¡Adiós! / ¡Chao! / ¡ADIÓS! ',
    '¡CHAO! / Hasta luego',
    'HASTA LUEGO',
    'ÁRBOL',
    'árbol',
    'Man: ¡Hola! Woman: ¡Buenas!',
    '¡HOLA! ¡BUENAS!',
  ].flatMap(spanishSideItems);

  expect(dedupeItems(items)).toEqual([
    { forms: [
      { spanish: '¡Adiós!', query: '¡adiós!' },
      { spanish: '¡Chao!', query: '¡chao!' },
    ] },
    { forms: [{ spanish: 'Hasta luego', query: 'hasta luego' }] },
    { forms: [{ spanish: 'ÁRBOL', query: 'árbol' }] },
    { forms: [{ spanish: '¡Hola! ¡Buenas!', query: '¡hola! ¡buenas!' }] },
  ]);
  expect(items[0]?.forms).toHaveLength(3);
  expect(items).toHaveLength(7);
});

test('dedupes incoming words before lookup even when the first occurrence fails', async () => {
  vi.spyOn(wordListParser, 'resolveWordList').mockResolvedValue([
    'ÁRBOL', ' árbol\t', 'Casa', 'CASA',
  ]);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockRejectedValueOnce(new Error('Lookup timed out after 1000 ms'))
    .mockResolvedValue(noun);

  expect(await generateForWords(db, 'pack items', lookup)).toEqual([
    {
      word: 'ÁRBOL', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Lookup timed out after 1000 ms',
    },
    { word: 'Casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['ÁRBOL'], ['Casa']]);
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
  expect(await db.select().from(cards)).toHaveLength(2);
});

test('reports a rejected stored-word read without lookup or writes', async () => {
  vi.spyOn(client, 'execute').mockRejectedValueOnce(new Error('Database read timed out after 1000 ms'));
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);

  const results = await generateForWords(db, 'casa', lookup);

  expect(results).toEqual([
    expect.objectContaining({
      word: 'casa', status: 'error', vocabCards: 0, conjugationCards: 0,
    }),
  ]);
  expect(results[0]?.message).toBe(
    'Failed query: select "words"."query" from "words" inner join "cards" on "cards"."word_id" = "words"."id"\nparams: ',
  );
  expect(cached).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([]);
  expect(await db.select().from(cards)).toEqual([]);
});

test.each([
  'Casa, hablar, CASA, por favor',
  'Casa; hablar; CASA; por favor',
  ' - Casa, 2) hablar; • CASA\n* por favor',
])('generates each cleaned delimiter item in order without extraction: %s', async (text) => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);

  const results = await generateForWords(db, text, lookup);

  expect(results.map((result) => result.word)).toEqual(['Casa', 'hablar', 'por favor']);
  expect(lookup.mock.calls).toEqual([['Casa'], ['hablar'], ['por favor']]);
});

test('an empty list produces no results or lookups', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect(await generateForWords(db, ' \n\t ', lookup)).toEqual([]);
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([]);
});

test('adds a noun and its example once, then reports skipped using the normalized query', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);
  const first: WordResult[] = await generateForWords(db, ' Casa \nCASA\n', lookup);

  expect(first).toEqual([{ word: 'Casa', status: 'added', vocabCards: 2, conjugationCards: 0 }]);
  expect(await generateForWords(db, 'casa', lookup)).toEqual([
    { word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
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

test('reports exists when a cached word with no cards generates a stored front in the same deck', async () => {
  const cachedInfo: WordInfo = { ...noun, example: null };
  const storedWords = [
    {
      id: 1, query: 'hogar', lookedUpAt: 123,
      info: JSON.stringify({ ...cachedInfo, spanish: 'hogar', gender: 'masculine', article: 'el' }),
    },
    { id: 2, query: 'casa', info: JSON.stringify(cachedInfo), lookedUpAt: 123 },
  ];
  const storedCard: typeof cards.$inferSelect = {
    id: 1, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'el hogar',
    tags: '["auto-generated"]', ankiNoteId: null, sentAt: null, declinedAt: null, createdAt: 123,
  };
  await db.insert(words).values(storedWords);
  await db.insert(cards).values(storedCard);
  expect(await db.select().from(words).orderBy(words.id)).toEqual(storedWords);
  expect(await db.select().from(cards)).toEqual([storedCard]);
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect(await generateForWords(db, 'casa', lookup)).toEqual([
    { word: 'casa', status: 'exists', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(cached).toHaveBeenCalledExactlyOnceWith(db, 'casa', lookup);
  expect(generate).toHaveBeenCalledExactlyOnceWith(cachedInfo);
  expect(generate).toHaveReturnedWith([
    {
      deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
      tags: ['auto-generated'],
    },
  ]);
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words).orderBy(words.id)).toEqual(storedWords);
  expect(await db.select().from(cards)).toEqual([storedCard]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
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
    { word: 'hablar', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
    { word: 'bailar', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup).toHaveBeenCalledTimes(2);
});

test('adds both irregular tenses without pattern claims and reports skipped on repeat', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(irregularVerb);

  expect(await generateForWords(db, 'ir', lookup)).toEqual([
    { word: 'ir', status: 'added', vocabCards: 1, conjugationCards: 2 },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  expect((await db.select().from(cards).orderBy(cards.id)).map((card) => card.front)).toEqual([
    'to go', 'Conjugate ir in present (irregular)', 'Conjugate ir in preterite (irregular)',
  ]);
  expect(await generateForWords(db, 'IR', lookup)).toEqual([
    { word: 'IR', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup).toHaveBeenCalledTimes(1);
});

test.each([
  { query: 'casa', word: 'CASA' },
  { query: 'CaSa', word: 'casa' },
  { query: 'ÁRBOL', word: 'árbol' },
  { query: '  ÁrBoL\t', word: 'Árbol' },
])('skips a query with one card before cache access or generation: $query', async ({ query, word }) => {
  const storedWord = { id: 1, query, info: 'unreadable cached info', lookedUpAt: 123 };
  const storedCard: typeof cards.$inferInsert = {
    wordId: 1, deck: 'Vocab', kind: 'basic', front: 'stored front', back: word,
    tags: '[]', createdAt: 123,
  };
  await db.insert(words).values(storedWord);
  await db.insert(cards).values(storedCard);
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  const conjugations = vi.spyOn(cardGenerator, 'conjugationCards');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect(await generateForWords(db, word, lookup)).toEqual([
    { word, status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(cached).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(conjugations).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([storedWord]);
  expect(await db.select().from(cards)).toEqual([expect.objectContaining(storedCard)]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('reports a stored-word read error before cache access and continues with the following word', async () => {
  vi.spyOn(db, 'select').mockImplementationOnce(() => {
    throw new Error('Stored-word query failed; retry later.');
  });
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);

  expect(await generateForWords(db, 'broken\ncasa', lookup)).toEqual([
    {
      word: 'broken', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Stored-word query failed; retry later.',
    },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(cached).toHaveBeenCalledExactlyOnceWith(db, 'casa', lookup);
  expect(lookup).toHaveBeenCalledExactlyOnceWith('casa');
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
  expect(await db.select().from(cards)).toHaveLength(2);
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

test('cards and pattern rows are not written when storage fails, and the following word is processed', async () => {
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

test('retries a word with no cards after a failed card insert and reports added from the cache', async () => {
  await client.execute(`
    CREATE TRIGGER reject_preterite_card BEFORE INSERT ON cards
    WHEN NEW.front = 'Conjugate hablar in preterite (regular -ar)'
    BEGIN SELECT RAISE(ABORT, 'card insert rejected'); END
  `);
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(regularVerb);

  const failed = await generateForWords(db, 'hablar', lookup);

  expect(failed).toEqual([
    expect.objectContaining({
      word: 'hablar', status: 'error', vocabCards: 0, conjugationCards: 0,
    }),
  ]);
  expect(failed[0]?.message).toContain('insert into "cards"');
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ id: 1, query: 'hablar' })]);
  expect(await db.select().from(cards)).toEqual([]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  await client.execute('DROP TRIGGER reject_preterite_card');
  cached.mockClear();
  generate.mockClear();

  expect(await generateForWords(db, 'HABLAR', lookup)).toEqual([
    { word: 'HABLAR', status: 'added', vocabCards: 1, conjugationCards: 2 },
  ]);
  expect(cached).toHaveBeenCalledExactlyOnceWith(db, 'HABLAR', lookup);
  expect(generate).toHaveBeenCalledExactlyOnceWith(regularVerb);
  expect(lookup).toHaveBeenCalledExactlyOnceWith('hablar');
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ id: 1, query: 'hablar' })]);
  expect((await db.select().from(cards).orderBy(cards.id)).map((card) => ({
    wordId: card.wordId, kind: card.kind, front: card.front,
  }))).toEqual([
    { wordId: 1, kind: 'basic', front: 'to speak' },
    { wordId: 1, kind: 'conjugation', front: 'Conjugate hablar in present (regular -ar)' },
    { wordId: 1, kind: 'conjugation', front: 'Conjugate hablar in preterite (regular -ar)' },
  ]);
  expect((await db.select().from(conjugationPatterns).orderBy(conjugationPatterns.id)).map((row) => ({
    ending: row.ending, pattern: row.pattern, tense: row.tense,
  }))).toEqual([
    { ending: 'ar', pattern: 'regular', tense: 'present' },
    { ending: 'ar', pattern: 'regular', tense: 'preterite' },
  ]);
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
