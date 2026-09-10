import { createClient, type Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import type OpenAI from 'openai';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ZodError } from 'zod';
import { loadConfig } from '@/lib/config';
import { formatResultLine } from '@/lib/resultLine';
import { WordInfoSchema, type WordInfo } from '@/lib/types';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, conjugationPatterns, words } from '@/server/db/schema';
import { openaiLookup } from './aiLookup';
import { conjugationCards, generateCards } from './cardGenerator';
import { generateForWords } from './listGenerationService';
import { cachedLookup } from './lookupCache';
import { createSpanishVoice } from './spanishVoice';

const { createCompletion } = vi.hoisted(() => ({
  createCompletion: vi.fn<OpenAI['chat']['completions']['create']>(),
}));

vi.mock('@/env', () => ({ env: {
  OPENAI_API_KEY: 'test-key', ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_VOICE_ID: 'test-voice',
} }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createCompletion } };
  },
}));

const supported = {
  english: 'house', spanish: 'casa', gender: 'feminine', article: 'la', type: 'noun',
  example: null, exampleWord: null, conjugations: null, conjugationClass: null, error: null,
};
const unsupported = {
  english: null, spanish: null, gender: null, article: null, type: null,
  example: null, exampleWord: null, conjugations: null, conjugationClass: null,
  error: 'Unsupported word: bonjour is not English or Spanish.',
};
const houseCard = {
  deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa', tags: ['auto-generated'],
};
const fetchImpl = vi.fn<typeof fetch>();
let client: Client;
let db: Db;

function respondWith(payload: unknown) {
  createCompletion.mockResolvedValueOnce({
    id: 'test-completion', object: 'chat.completion', created: 0, model: 'test-model',
    choices: [{
      index: 0, finish_reason: 'stop', logprobs: null,
      message: { role: 'assistant', content: JSON.stringify(payload), refusal: null },
    }],
  });
}

beforeEach(async () => {
  createCompletion.mockReset();
  fetchImpl.mockReset().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([73, 68, 51]))));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  client = createClient({ url: ':memory:' });
  db = createDb(client);
  await applyMigrations(db);
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  client.close();
});

test('a supported lookup with explicit null error parses and generates string card faces', async () => {
  expect(WordInfoSchema.safeParse(supported).success).toBe(true);
  respondWith(supported);

  const info = await openaiLookup('casa');

  expect(info).toEqual(supported);
  expect(generateCards(info)).toEqual([houseCard]);
  expect(generateCards({ forms: [{ spanish: 'casa', query: 'casa', info }] })).toEqual([houseCard]);
  expect(generateCards({ forms: [
    { spanish: 'casa', query: 'casa', info },
    { spanish: 'casita', query: 'casita', info: { ...info, spanish: 'casita' } },
  ] })).toEqual([{ ...houseCard, back: 'casa / casita', forms: [
    { spanish: 'casa', query: 'casa' }, { spanish: 'casita', query: 'casita' },
  ] }]);
});

test('a supported-shaped reply with a string error parses through the error branch', () => {
  const payload = { ...supported, error: 'Unsupported word: bonjour is not English or Spanish.' };

  expect(WordInfoSchema.parse(payload)).toEqual(payload);
});

test.each([null, 'ser'])('an error reply with an unusable ending of %s drops the class and preserves the error', async (ending) => {
  respondWith({
    ...unsupported, conjugationClass: { ending, present: 'regular', preterite: 'regular' },
  });

  await expect(openaiLookup('bonjour')).resolves.toStrictEqual(unsupported);
  expect(createCompletion).toHaveBeenCalledOnce();
});

test.each([null, 'ser'])('the 2026-09-09 ending failure %s drops only the class before parsing', async (ending) => {
  const payload = {
    ...supported, english: 'to be', spanish: 'ser', gender: null, article: null, type: 'verb',
    conjugations: { present: { yo: 'soy' }, preterite: { yo: 'fui' } },
    conjugationClass: { ending, present: 'irregular', preterite: 'irregular' },
  };
  const expected = { ...payload, conjugationClass: null };

  expect(WordInfoSchema.parse(payload)).toStrictEqual(expected);
  expect(payload.conjugationClass).toStrictEqual({ ending, present: 'irregular', preterite: 'irregular' });
  respondWith(payload);

  await expect(openaiLookup('ser')).resolves.toStrictEqual(expected);
  expect(createCompletion).toHaveBeenCalledOnce();
});

test.each(['ar', 'er', 'ir'])('an ending of %s keeps the conjugation class intact', (ending) => {
  const payload = {
    ...supported, conjugationClass: { ending, present: 'e-ie', preterite: 'irregular' },
  };

  expect(WordInfoSchema.parse(payload)).toStrictEqual(payload);
});

test('a conjugation class with no ending key drops to null', async () => {
  const payload = {
    ...supported, conjugationClass: { present: 'regular', preterite: 'regular' },
  };
  respondWith(payload);

  await expect(openaiLookup('casa')).resolves.toStrictEqual({ ...supported, conjugationClass: null });
  expect(payload.conjugationClass).toStrictEqual({ present: 'regular', preterite: 'regular' });
  expect(createCompletion).toHaveBeenCalledOnce();
});

test('a null conjugation class stays null', () => {
  expect(WordInfoSchema.parse(supported)).toStrictEqual(supported);
});

test('an absent conjugation class stays absent', () => {
  const payload: Record<string, unknown> = { ...supported };
  delete payload.conjugationClass;

  expect(WordInfoSchema.parse(payload)).toStrictEqual(payload);
  expect(WordInfoSchema.parse(payload)).not.toHaveProperty('conjugationClass');
});

test.each(['present', 'preterite'])('a valid ending still rejects an unknown %s pattern', async (tense) => {
  const payload = {
    ...supported,
    conjugationClass: { ending: 'ar', present: 'regular', preterite: 'regular', [tense]: 'unknown' },
  };
  expect(() => WordInfoSchema.parse(payload)).toThrow(ZodError);
  respondWith(payload);

  const answer = openaiLookup('casa');

  await expect(answer).rejects.toHaveProperty('message',
    `AI response did not match the expected shape: [{"received":"unknown","code":"invalid_enum_value","options":["regular","e-ie","o-ue","e-i","u-ue","irregular"],"path":["conjugationClass","${tense}"],"message":"Invalid enum value. Expected 'regular' | 'e-ie' | 'o-ue' | 'e-i' | 'u-ue' | 'irregular', received 'unknown'"}]`,
  );
  await expect(answer).rejects.toHaveProperty('cause', expect.any(ZodError));
  expect(console.error).toHaveBeenCalledOnce();
});

test.each(['present', 'preterite'])('a valid ending still requires the %s pattern key', (tense) => {
  const conjugationClass: Record<string, unknown> = {
    ending: 'ar', present: 'regular', preterite: 'regular',
  };
  delete conjugationClass[tense];

  expect(() => WordInfoSchema.parse({ ...supported, conjugationClass })).toThrow(ZodError);
});

test.each([null, [], 'casa', 42])('a non-object reply still fails parsing: %j', (payload) => {
  expect(() => WordInfoSchema.parse(payload)).toThrow(ZodError);
});

test.each(['ar', 42, true, []])('a non-object conjugation class still fails parsing: %j', (conjugationClass) => {
  expect(() => WordInfoSchema.parse({ ...supported, conjugationClass })).toThrow(ZodError);
});

test.each([null, 'ser'])('dropping an ending of %s cannot hide numeric english or a missing required key', (ending) => {
  const payload = {
    ...supported, conjugationClass: { ending, present: 'regular', preterite: 'regular' },
  };
  const missingGender: Record<string, unknown> = { ...payload };
  delete missingGender.gender;

  expect(() => WordInfoSchema.parse({ ...payload, english: 42 })).toThrow(ZodError);
  expect(() => WordInfoSchema.parse(missingGender)).toThrow(ZodError);
});

test('a supported reply missing gender reports only the supported branch', async () => {
  const payload: Record<string, unknown> = { ...supported };
  delete payload.gender;
  respondWith(payload);

  const answer = openaiLookup('casa');

  await expect(answer).rejects.toHaveProperty('message',
    'AI response did not match the expected shape: [{"code":"invalid_type","expected":"string","received":"undefined","path":["gender"],"message":"Required"}]',
  );
  await expect(answer).rejects.not.toHaveProperty('message', expect.stringContaining('"error"'));
  await expect(answer).rejects.toHaveProperty('cause', expect.any(ZodError));
  expect(console.error).toHaveBeenCalledOnce();
});

test('an error reply with numeric english reports only the error branch', async () => {
  respondWith({ error: 'Unsupported word: bonjour is not English or Spanish.', english: 42 });

  const answer = openaiLookup('bonjour');

  await expect(answer).rejects.toHaveProperty('message',
    'AI response did not match the expected shape: [{"code":"invalid_type","expected":"string","received":"number","path":["english"],"message":"Expected string, received number"}]',
  );
  await expect(answer).rejects.not.toHaveProperty('message', expect.stringContaining('spanish'));
  await expect(answer).rejects.not.toHaveProperty('message', expect.stringContaining('conjugations'));
  await expect(answer).rejects.toHaveProperty('cause', expect.any(ZodError));
  expect(console.error).toHaveBeenCalledOnce();
});

test('a reply with numeric error preserves both branches exactly', async () => {
  respondWith({ ...supported, error: 42 });

  await expect(openaiLookup('casa')).rejects.toHaveProperty('message',
    'AI response did not match the expected shape: [{"code":"invalid_union","unionErrors":[{"issues":[{"code":"invalid_type","expected":"null","received":"number","path":["error"],"message":"Expected null, received number"}],"name":"ZodError"},{"issues":[{"code":"invalid_type","expected":"string","received":"number","path":["error"],"message":"Expected string, received number"}],"name":"ZodError"}],"path":[],"message":"Invalid input"}]',
  );
  expect(console.error).toHaveBeenCalledOnce();
});

test('a non-object reply preserves both branches exactly', async () => {
  respondWith(null);

  await expect(openaiLookup('casa')).rejects.toHaveProperty('message',
    'AI response did not match the expected shape: [{"code":"invalid_union","unionErrors":[{"issues":[{"code":"invalid_type","expected":"object","received":"null","path":[],"message":"Expected object, received null"}],"name":"ZodError"},{"issues":[{"code":"invalid_type","expected":"object","received":"null","path":[],"message":"Expected object, received null"}],"name":"ZodError"}],"path":[],"message":"Invalid input"}]',
  );
  expect(console.error).toHaveBeenCalledOnce();
});

test('generation stores cards from a supported OpenAI response with null error', async () => {
  respondWith(supported);

  const result = await generateForWords(db, 'casa', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(result.results).toEqual([{ word: 'casa', status: 'added', vocabCards: 1, conjugationCards: 0 }]);
  expect(result.results.map(formatResultLine)).toEqual(['1 vocab card']);
  expect(await db.select({ front: cards.front, back: cards.back }).from(cards)).toEqual([
    { front: 'house', back: 'la casa' },
  ]);
  expect(await cachedLookup(db, 'casa', openaiLookup)).toEqual(supported);
  expect(createCompletion).toHaveBeenCalledOnce();
});

test.each([null, 'ser'])('generation drops an unusable ending of %s and reports plain vocab success', async (ending) => {
  const payload = {
    ...supported, english: 'to be', spanish: 'ser', gender: null, article: null, type: 'verb',
    conjugations: { present: { yo: 'soy' }, preterite: { yo: 'fui' } },
    conjugationClass: { ending, present: 'regular', preterite: 'irregular' },
  };
  respondWith(payload);

  const result = await generateForWords(db, 'ser', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(result.results).toEqual([{ word: 'ser', status: 'added', vocabCards: 1, conjugationCards: 0 }]);
  expect(result.results.map(formatResultLine)).toEqual(['1 vocab card']);
  expect(await db.select({ deck: cards.deck, kind: cards.kind, front: cards.front, back: cards.back }).from(cards)).toEqual([
    { deck: 'Spanish::Vocab', kind: 'basic', front: 'to be', back: 'ser' },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  expect(await db.select({ query: words.query, info: words.info }).from(words)).toEqual([
    { query: 'ser', info: JSON.stringify({ ...payload, conjugationClass: null }) },
  ]);
  expect(createCompletion).toHaveBeenCalledOnce();
});

test('generation reports a gated phrase and leaves its shared patterns for the next verb', async () => {
  const phrase = {
    english: 'we like', spanish: 'Nos gusta', gender: null, article: null, type: 'verb',
    example: 'Nos gusta la música. (We like music.)', exampleWord: 'Nos gusta',
    conjugations: { present: { yo: 'gusto' }, preterite: { yo: 'gusté' } },
    conjugationClass: { ending: 'ar', present: 'regular', preterite: 'regular' }, error: null,
  };
  respondWith({ items: ['Nos gusta'] });
  respondWith(phrase);

  const phraseResult = await generateForWords(db, 'Nos gusta', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(phraseResult.results).toEqual([{
    word: 'Nos gusta', status: 'added', vocabCards: 2, conjugationCards: 0,
    message: '0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.',
  }]);
  expect(phraseResult.results.map(formatResultLine)).toEqual([
    '2 vocab cards; 0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.',
  ]);
  expect(await db.select({ deck: cards.deck, kind: cards.kind, front: cards.front, back: cards.back }).from(cards).orderBy(cards.id)).toEqual([
    { deck: 'Spanish::Vocab', kind: 'basic', front: 'we like', back: 'Nos gusta' },
    {
      deck: 'Spanish::Vocab', kind: 'example', front: '____ la música.',
      back: 'Nos gusta (we like)<br>(We like music.)',
    },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  const cachedWords = await db.select({ query: words.query, info: words.info }).from(words);
  expect(cachedWords.map(({ query, info }) => {
    const storedInfo: unknown = JSON.parse(info);
    return { query, info: storedInfo };
  })).toEqual([{
    query: 'nos gusta', info: {
      english: 'we like', spanish: 'Nos gusta', gender: null, article: null, type: 'verb',
      example: 'Nos gusta la música. (We like music.)', exampleWord: 'Nos gusta',
      conjugations: { present: { yo: 'gusto' }, preterite: { yo: 'gusté' } },
      conjugationClass: { ending: 'ar', present: 'regular', preterite: 'regular' }, error: null,
    },
  }]);
  expect(createCompletion).toHaveBeenCalledTimes(2);

  const verb = {
    ...phrase, english: 'to speak', spanish: 'hablar', example: null, exampleWord: null,
    conjugations: { present: { yo: 'hablo' }, preterite: { yo: 'hablé' } },
  };
  respondWith(verb);

  const verbResult = await generateForWords(db, 'hablar', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(verbResult.results).toEqual([{ word: 'hablar', status: 'added', vocabCards: 1, conjugationCards: 2 }]);
  expect(verbResult.results.map(formatResultLine)).toEqual(['1 vocab card plus 2 conjugation cards']);
  expect(await db.select({ deck: cards.deck, kind: cards.kind, front: cards.front, back: cards.back }).from(cards).orderBy(cards.id)).toEqual([
    { deck: 'Spanish::Vocab', kind: 'basic', front: 'we like', back: 'Nos gusta' },
    {
      deck: 'Spanish::Vocab', kind: 'example', front: '____ la música.',
      back: 'Nos gusta (we like)<br>(We like music.)',
    },
    { deck: 'Spanish::Vocab', kind: 'basic', front: 'to speak', back: 'hablar' },
    {
      deck: 'Spanish::Conjugation', kind: 'conjugation',
      front: 'Conjugate hablar in present (regular -ar)', back: 'yo: hablo',
    },
    {
      deck: 'Spanish::Conjugation', kind: 'conjugation',
      front: 'Conjugate hablar in preterite (regular -ar)', back: 'yo: hablé',
    },
  ]);
  expect(await db.select({
    ending: conjugationPatterns.ending, pattern: conjugationPatterns.pattern,
    tense: conjugationPatterns.tense, front: cards.front,
  }).from(conjugationPatterns).innerJoin(cards, eq(cards.id, conjugationPatterns.cardId)).orderBy(conjugationPatterns.id)).toEqual([
    { ending: 'ar', pattern: 'regular', tense: 'present', front: 'Conjugate hablar in present (regular -ar)' },
    { ending: 'ar', pattern: 'regular', tense: 'preterite', front: 'Conjugate hablar in preterite (regular -ar)' },
  ]);
  expect(createCompletion).toHaveBeenCalledTimes(3);
});

test('generation reports an ending mismatch without claiming a pattern', async () => {
  respondWith({
    english: 'to eat', spanish: 'comer', gender: null, article: null, type: 'verb',
    example: null, exampleWord: null, error: null,
    conjugations: { present: { yo: 'como' }, preterite: { yo: 'comí' } },
    conjugationClass: { ending: 'ar', present: 'regular', preterite: 'regular' },
  });

  const result = await generateForWords(db, 'comer', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(result.results).toEqual([{
    word: 'comer', status: 'added', vocabCards: 1, conjugationCards: 0,
    message: '0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.',
  }]);
  expect(result.results.map(formatResultLine)).toEqual([
    '1 vocab card; 0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.',
  ]);
  expect(await db.select({ kind: cards.kind, front: cards.front, back: cards.back }).from(cards)).toEqual([
    { kind: 'basic', front: 'to eat', back: 'comer' },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  expect(createCompletion).toHaveBeenCalledOnce();
});

test('the 2026-09-09 supported payload with conjugations omitted parses', async () => {
  const payload: Record<string, unknown> = { ...supported };
  delete payload.conjugations;
  delete payload.exampleWord;

  expect(WordInfoSchema.parse(payload)).toEqual(payload);
  respondWith(payload);

  await expect(openaiLookup('casa')).resolves.toEqual(payload);
  expect(createCompletion).toHaveBeenCalledOnce();
});

test('generation stores cards from the 2026-09-09 supported payload with conjugations omitted', async () => {
  const payload: Record<string, unknown> = { ...supported };
  delete payload.conjugations;
  delete payload.exampleWord;
  respondWith(payload);

  const result = await generateForWords(db, 'casa', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(result.results).toEqual([{ word: 'casa', status: 'added', vocabCards: 1, conjugationCards: 0 }]);
  expect(await db.select({ deck: cards.deck, kind: cards.kind, front: cards.front, back: cards.back }).from(cards)).toEqual([
    { deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa' },
  ]);
  expect(await db.select({ query: words.query, info: words.info }).from(words)).toEqual([
    { query: 'casa', info: JSON.stringify(payload) },
  ]);
  expect(await cachedLookup(db, 'casa', openaiLookup)).toEqual(payload);
  expect(createCompletion).toHaveBeenCalledOnce();
});

test('a stored 2026-09-09 supported payload with conjugations omitted reads back through cachedLookup', async () => {
  const payload: Record<string, unknown> = { ...supported };
  delete payload.conjugations;
  delete payload.exampleWord;
  await db.insert(words).values({ query: 'casa', info: JSON.stringify(payload), lookedUpAt: 123 });

  await expect(cachedLookup(db, 'casa', openaiLookup)).resolves.toEqual(payload);
  expect(createCompletion).not.toHaveBeenCalled();
  expect(await db.select({ info: words.info }).from(words)).toEqual([{ info: JSON.stringify(payload) }]);
});

test('the live Diecinueve payload with null type stores cards and serves the next lookup from cache', async () => {
  const payload = {
    english: 'Nineteen', spanish: 'Diecinueve', gender: null, article: null, type: null,
    example: 'Hoy es el diecinueve de septiembre. (Today is the nineteenth of September.)',
    exampleWord: null, conjugations: null, conjugationClass: null, error: null,
  };
  respondWith(payload);

  const result = await generateForWords(db, 'Diecinueve', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(result.results).toEqual([{ word: 'Diecinueve', status: 'added', vocabCards: 2, conjugationCards: 0 }]);
  expect(await db.select({ kind: cards.kind, front: cards.front, back: cards.back }).from(cards).orderBy(cards.id)).toEqual([
    { kind: 'basic', front: 'Nineteen', back: 'Diecinueve' },
    {
      kind: 'example', front: 'Hoy es el ____ de septiembre.',
      back: 'Diecinueve (Nineteen)<br>(Today is the nineteenth of September.)',
    },
  ]);
  expect(await db.select({ query: words.query, info: words.info }).from(words)).toEqual([
    { query: 'diecinueve', info: JSON.stringify(payload) },
  ]);
  expect(createCompletion).toHaveBeenCalledOnce();

  expect(await cachedLookup(db, 'Diecinueve', openaiLookup)).toEqual(payload);
  expect(createCompletion).toHaveBeenCalledOnce();
});

test('an unsupported OpenAI payload with null fields yields one result line with the model message', async () => {
  respondWith(unsupported);

  const result = await generateForWords(db, 'bonjour', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(result.results).toEqual([{
    word: 'bonjour', status: 'error', vocabCards: 0, conjugationCards: 0,
    message: 'Unsupported word: bonjour is not English or Spanish.',
  }]);
  expect(result.results.map(formatResultLine)).toEqual(['Unsupported word: bonjour is not English or Spanish.']);
  expect(await db.select().from(words)).toEqual([]);
  expect(await db.select().from(cards)).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('an error-only OpenAI payload parses and yields one result line with the model message', async () => {
  const payload = { error: 'Unsupported word: bonjour is not English or Spanish.' };
  expect(WordInfoSchema.safeParse(payload).success).toBe(true);
  respondWith(payload);

  const result = await generateForWords(db, 'bonjour', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(result.results).toEqual([{
    word: 'bonjour', status: 'error', vocabCards: 0, conjugationCards: 0,
    message: 'Unsupported word: bonjour is not English or Spanish.',
  }]);
  expect(result.results.map(formatResultLine)).toEqual(['Unsupported word: bonjour is not English or Spanish.']);
  expect(await db.select().from(words)).toEqual([]);
  expect(await db.select().from(cards)).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([
  { shape: 'supported', query: 'casa', payload: supported },
  { shape: 'unsupported', query: 'bonjour', payload: unsupported },
])('a stored $shape lookup row round-trips through the shared schema', async ({ query, payload }) => {
  await db.insert(words).values({ query, info: JSON.stringify(payload), lookedUpAt: 123 });

  await expect(cachedLookup(db, query, openaiLookup)).resolves.toEqual(payload);
  expect(createCompletion).not.toHaveBeenCalled();
  expect(await db.select({ info: words.info }).from(words)).toEqual([{ info: JSON.stringify(payload) }]);
});

test('the lookup prompt requires null error for supported words and never omission', async () => {
  respondWith(supported);
  await openaiLookup('casa');

  const prompt = createCompletion.mock.calls[0]?.[0].messages[0]?.content;
  expect(prompt).toContain('If the word is supported, error must be null; never omit this field.');
  expect(prompt).toContain('return null for the other fields');
  expect(prompt).not.toContain("don't include this field");
  expect(prompt).toContain('never put the translation in a separate JSON key.');
  expect(prompt).toContain('Do not include any other top-level key, preamble, or explanation.');
});

test('a null type is accepted in a supported lookup', () => {
  const payload = { ...supported, type: null };

  expect(WordInfoSchema.safeParse(payload).success).toBe(true);
});

test.each(['english', 'spanish'])(
  'a null error cannot turn a null %s into a successful lookup', (field) => {
    expect(WordInfoSchema.safeParse({ ...supported, [field]: null }).success).toBe(false);
  },
);

test.each(['english', 'spanish', 'gender', 'article', 'example', 'type'])('a supported lookup still requires the %s key', (field) => {
  const payload: Record<string, unknown> = { ...supported };
  delete payload[field];

  expect(() => WordInfoSchema.parse(payload)).toThrow(ZodError);
});

test.each([{ type: 42 }, { type: true }, { type: {} }, { type: [] }])(
  'a supported lookup rejects a non-string non-null type: $type', ({ type }) => {
    expect(WordInfoSchema.safeParse({ ...supported, type }).success).toBe(false);
  },
);

test.each(['word', 'conjugations'])(
  'the %s card entry point reports a lookup error before generating cards', (entry) => {
    const info = { ...supported, error: 'Unsupported word: bonjour is not English or Spanish.' };

    expect(() => entry === 'word' ? generateCards(info) : conjugationCards(info, new Set())).toThrow(
      'Cannot generate cards: lookup returned error "Unsupported word: bonjour is not English or Spanish.".',
    );
  },
);

test('an empty error string is still a lookup failure and is never cached', async () => {
  const info = { ...supported, error: '' };
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(info);

  expect(await cachedLookup(db, 'bonjour', lookup)).toEqual(info);
  expect(await cachedLookup(db, 'bonjour', lookup)).toEqual(info);
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(await db.select().from(words)).toEqual([]);
});

test('an OpenAI rejection reports the observed message and commits no word or cards', async () => {
  createCompletion.mockRejectedValueOnce(new Error('OpenAI returned HTTP 503: Service Unavailable'));

  const result = await generateForWords(db, 'casa', openaiLookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(result.results).toEqual([{
    word: 'casa', status: 'error', vocabCards: 0, conjugationCards: 0,
    message: 'OpenAI returned HTTP 503: Service Unavailable',
  }]);
  expect(await db.select().from(words)).toEqual([]);
  expect(await db.select().from(cards)).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});
