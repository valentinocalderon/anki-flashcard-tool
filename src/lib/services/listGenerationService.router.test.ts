import { createClient, type Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WordInfo } from '@/lib/types';
import { ankiRouter } from '@/server/api/routers/lookupRouter';
import * as database from '@/server/db';
import { cards, words } from '@/server/db/schema';
import { openaiLookup } from './aiLookup';
import * as ankiSender from './ankiSender';
import { storeCards } from './cardStore';
import * as listGeneration from './listGenerationService';
import * as spanishVoice from './spanishVoice';

vi.mock('@/env', () => ({ env: {
  OPENAI_API_KEY: 'test-key', ELEVENLABS_API_KEY: 'test-api-key', ELEVENLABS_VOICE_ID: 'test-voice-id',
} }));
vi.mock('./aiLookup', () => ({
  askForJson: vi.fn().mockRejectedValue(new Error('Unexpected extraction request')),
  openaiLookup: vi.fn().mockRejectedValue(new Error('Unexpected live lookup')),
}));

const wordInfo: WordInfo = {
  english: 'yes', spanish: 'sí', gender: null, article: null, type: 'interjection',
  example: null, conjugations: null,
};
const fetchImpl = vi.fn<typeof fetch>();
let client: Client;
let db: database.Db;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
  fetchImpl.mockReset().mockImplementation(async (url, init) => {
    if (url === 'https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128' && init?.method === 'POST') {
      return new Response(new Uint8Array([73, 68, 51]));
    }
    throw new Error('Unexpected fetch; provide a fixture response.');
  });
  vi.stubGlobal('fetch', fetchImpl);
  vi.mocked(openaiLookup).mockClear();
  client = createClient({ url: ':memory:' });
  db = database.createDb(client);
  await database.applyMigrations(db);
  vi.spyOn(database, 'getDb').mockResolvedValue(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  client.close();
});

test('the router builds one voice per request and shares its budget across all generated items', async () => {
  const createVoice = vi.spyOn(spanishVoice, 'createSpanishVoice');
  const generate = vi.spyOn(listGeneration, 'generateForWords');
  vi.spyOn(ankiSender, 'sendPending')
    .mockResolvedValueOnce({ status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: 123, message: null })
    .mockResolvedValueOnce({ status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 456, message: null });
  vi.mocked(openaiLookup)
    .mockResolvedValueOnce({ ...wordInfo, spanish: 'a'.repeat(15000), english: 'house' })
    .mockResolvedValueOnce({ ...wordInfo, spanish: 'b'.repeat(15000), english: 'home' })
    .mockResolvedValueOnce(wordInfo)
    .mockResolvedValueOnce({ ...wordInfo, spanish: 'árbol', english: 'tree' });
  const caller = ankiRouter.createCaller({ headers: new Headers() });

  const report = await caller.generateFromList({ text: 'casa\nhogar\nsí' });

  expect(createVoice).toHaveBeenCalledExactlyOnceWith({ capCharacters: 30000 }, fetchImpl);
  const created = createVoice.mock.results[0];
  if (created?.type !== 'return') throw new Error('Expected the router to create a voice.');
  expect(generate.mock.calls[0]).toHaveLength(5);
  expect(generate).toHaveBeenCalledExactlyOnceWith(db, 'casa\nhogar\nsí', openaiLookup, fetchImpl, created.value);
  expect(created.value.dispatchedCharacters).toBe(30000);
  expect(created.value.capReached).toBe(true);
  expect(fetchImpl.mock.calls.map(([, init]) => init?.body)).toEqual([
    JSON.stringify({ text: 'a'.repeat(15000), model_id: 'eleven_multilingual_v2' }),
    JSON.stringify({ text: 'b'.repeat(15000), model_id: 'eleven_multilingual_v2' }),
  ]);
  expect(await db.select({ front: cards.front, audioMp3: cards.audioMp3 }).from(cards).orderBy(cards.id)).toEqual([
    { front: 'house', audioMp3: Buffer.from([73, 68, 51]) },
    { front: 'home', audioMp3: Buffer.from([73, 68, 51]) },
    { front: 'yes', audioMp3: null },
  ]);
  expect(report).toEqual({ capReached: true, results: [
    { word: 'casa', status: 'added', vocabCards: 1, conjugationCards: 0 },
    { word: 'hogar', status: 'added', vocabCards: 1, conjugationCards: 0 },
    { word: 'sí', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ], send: { status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: 123, message: null },
  backfill: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null } });

  expect(await caller.generateFromList({ text: 'árbol' })).toEqual({ capReached: false, results: [
    { word: 'árbol', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ], send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 456, message: null },
  backfill: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null } });
  expect(createVoice).toHaveBeenCalledTimes(2);
  expect(createVoice).toHaveBeenNthCalledWith(2, { capCharacters: 30000 }, fetchImpl);
  const next = createVoice.mock.results[1];
  if (next?.type !== 'return') throw new Error('Expected the next request to create a voice.');
  expect(next.value).not.toBe(created.value);
  expect(generate).toHaveBeenNthCalledWith(2, db, 'árbol', openaiLookup, fetchImpl, next.value);
  expect(next.value.dispatchedCharacters).toBe(5);
  expect(next.value.capReached).toBe(false);
  expect(created.value.dispatchedCharacters).toBe(30000);
  expect(created.value.capReached).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(fetchImpl.mock.calls[2]?.[1]?.body).toBe('{"text":"árbol","model_id":"eleven_multilingual_v2"}');
});

const storedHouse = {
  id: 1, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
  tags: '[]', forms: null, createdAt: 123, sentAt: 456, ankiNoteId: 101, declinedAt: null,
  audioFile: null, audioMp3: null, audioSentAt: null,
} satisfies typeof cards.$inferSelect;
const houseAudio = 'card-39ea127757ece19e4f940e03a400b6cc3fae452580ca79223e0d6b75148a5477.mp3';

function ankiResponse(result: string | number | (number | null)[] | null) {
  return Response.json({ result, error: null });
}

function requestBodies() {
  return fetchImpl.mock.calls.map(([, init]): unknown => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
    return JSON.parse(init.body);
  });
}

async function seedHouse() {
  await db.insert(words).values({ id: 1, query: 'casa', info: '{}', lookedUpAt: 123 });
  await db.insert(cards).values(storedHouse);
}

test.each(['sendPending', 'retryDeclined'] as const)(
  'generation and backfill spend one cap after sending, and %s gets a fresh voice', async (mutation) => {
    await seedHouse();
    await db.insert(cards).values({ ...storedHouse, id: 2, front: 'second', ankiNoteId: 102 });
    const createVoice = vi.spyOn(spanishVoice, 'createSpanishVoice');
    vi.mocked(openaiLookup).mockResolvedValueOnce({ ...wordInfo, spanish: 'a'.repeat(29990) });
    fetchImpl
      .mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51])))
      .mockResolvedValueOnce(ankiResponse(1))
      .mockResolvedValueOnce(ankiResponse('new.mp3'))
      .mockResolvedValueOnce(ankiResponse([103]))
      .mockResolvedValueOnce(ankiResponse(null))
      .mockResolvedValueOnce(new Response(new Uint8Array([73])))
      .mockResolvedValueOnce(ankiResponse('house.mp3'))
      .mockResolvedValueOnce(ankiResponse(null));
    const caller = ankiRouter.createCaller({ headers: new Headers() });

    expect(await caller.generateFromList({ text: 'sí' })).toEqual({
      results: [{ word: 'sí', status: 'added', vocabCards: 1, conjugationCards: 0 }], capReached: true,
      send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 1800000000000, message: null },
      backfill: { status: 'sent', sent: 1, rejected: 0, pending: 1, syncedAt: null, message: null },
    });
    expect(createVoice).toHaveBeenCalledExactlyOnceWith({ capCharacters: 30000 }, fetchImpl);
    const firstVoice = createVoice.mock.results[0];
    if (firstVoice?.type !== 'return') throw new Error('Expected a voice.');
    expect(firstVoice.value.dispatchedCharacters).toBe(29997);
    expect(firstVoice.value.capReached).toBe(true);
    expect(requestBodies().slice(4)).toEqual([
      { action: 'sync', version: 6, params: {} },
      { text: 'la casa', model_id: 'eleven_multilingual_v2' },
      { action: 'storeMediaFile', version: 6, params: { filename: houseAudio, data: 'SQ==' } },
      { action: 'updateNoteFields', version: 6, params: { note: {
        id: 101, fields: { Back: 'la casa [sound:house.mp3]' },
      } } },
    ]);
    expect(await db.select({ id: cards.id, sentAt: cards.sentAt, audioSentAt: cards.audioSentAt })
      .from(cards).orderBy(cards.id)).toEqual([
      { id: 1, sentAt: 456, audioSentAt: 1800000000000 },
      { id: 2, sentAt: 456, audioSentAt: null },
      { id: 3, sentAt: 1800000000000, audioSentAt: 1800000000000 },
    ]);

    fetchImpl
      .mockResolvedValueOnce(new Response(new Uint8Array([68])))
      .mockResolvedValueOnce(ankiResponse('second.mp3'))
      .mockResolvedValueOnce(ankiResponse(null));
    expect(await caller[mutation]()).toEqual({
      send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
      backfill: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null },
    });
    expect(createVoice).toHaveBeenCalledTimes(2);
    expect(createVoice).toHaveBeenNthCalledWith(2, { capCharacters: 30000 }, fetchImpl);
    const nextVoice = createVoice.mock.results[1];
    if (nextVoice?.type !== 'return') throw new Error('Expected a fresh voice.');
    expect(nextVoice.value).not.toBe(firstVoice.value);
    expect(nextVoice.value.dispatchedCharacters).toBe(7);
    expect(nextVoice.value.capReached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(11);
    expect(vi.mocked(openaiLookup)).toHaveBeenCalledOnce();
  },
);

test('retryDeclined sends a previously declined card without cached audio and backfills it in the same request', async () => {
  await seedHouse();
  await db.update(cards).set({ sentAt: null, ankiNoteId: null, declinedAt: 456 }).where(eq(cards.id, 1));
  const createVoice = vi.spyOn(spanishVoice, 'createSpanishVoice');
  fetchImpl
    .mockResolvedValueOnce(ankiResponse(1))
    .mockResolvedValueOnce(ankiResponse([101]))
    .mockResolvedValueOnce(ankiResponse(null))
    .mockResolvedValueOnce(new Response(new Uint8Array([73])))
    .mockResolvedValueOnce(ankiResponse('house.mp3'))
    .mockResolvedValueOnce(ankiResponse(null));
  const caller = ankiRouter.createCaller({ headers: new Headers() });

  expect(await caller.retryDeclined()).toEqual({
    send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 1800000000000, message: null },
    backfill: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null },
  });
  expect(createVoice).toHaveBeenCalledExactlyOnceWith({ capCharacters: 30000 }, fetchImpl);
  const voice = createVoice.mock.results[0];
  if (voice?.type !== 'return') throw new Error('Expected a voice.');
  expect(voice.value.dispatchedCharacters).toBe(7);
  expect(voice.value.capReached).toBe(false);
  expect(requestBodies()).toEqual([
    { action: 'createDeck', version: 6, params: { deck: 'Spanish::Vocab' } },
    { action: 'addNotes', version: 6, params: { notes: [{
      deckName: 'Spanish::Vocab', modelName: 'Basic (and reversed card)',
      fields: { Front: 'house', Back: 'la casa' }, tags: [],
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    }] } },
    { action: 'sync', version: 6, params: {} },
    { text: 'la casa', model_id: 'eleven_multilingual_v2' },
    { action: 'storeMediaFile', version: 6, params: { filename: houseAudio, data: 'SQ==' } },
    { action: 'updateNoteFields', version: 6, params: { note: {
      id: 101, fields: { Back: 'la casa [sound:house.mp3]' },
    } } },
  ]);
  expect(await db.select().from(cards).get()).toEqual({
    ...storedHouse, sentAt: 1800000000000, audioFile: houseAudio,
    audioMp3: Buffer.from([73]), audioSentAt: 1800000000000,
  });
  expect(await caller.declinedCount()).toBe(0);
  expect(await caller.pendingCount()).toBe(0);
  expect(openaiLookup).not.toHaveBeenCalled();
});

test.each(['generateFromList', 'sendPending', 'retryDeclined'] as const)(
  '%s backfills an existing note once and pushes its changed audio again', async (mutation) => {
    await seedHouse();
    fetchImpl
      .mockResolvedValueOnce(new Response(new Uint8Array([73])))
      .mockResolvedValueOnce(ankiResponse('house.mp3'))
      .mockResolvedValueOnce(ankiResponse(null));
    const caller = ankiRouter.createCaller({ headers: new Headers() });
    const run = () => mutation === 'generateFromList' ? caller.generateFromList({ text: 'casa' }) : caller[mutation]();
    const generation = mutation === 'generateFromList' ? {
      results: [{ word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 }], capReached: false,
    } : {};
    expect(await run()).toEqual({
      ...generation,
      send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
      backfill: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null },
    });
    expect(requestBodies()).toEqual([
      { text: 'la casa', model_id: 'eleven_multilingual_v2' },
      { action: 'storeMediaFile', version: 6, params: { filename: houseAudio, data: 'SQ==' } },
      { action: 'updateNoteFields', version: 6, params: { note: {
        id: 101, fields: { Back: 'la casa [sound:house.mp3]' },
      } } },
    ]);
    expect(await run()).toEqual({
      ...generation,
      send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
      backfill: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    expect(await storeCards(db, 1, [{
      deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa / el hogar', tags: [],
      forms: [{ spanish: 'la casa', query: 'casa' }, { spanish: 'el hogar', query: 'hogar' }],
      audioFile: 'changed.mp3', audioMp3: Buffer.from([68]),
    }], [], 1)).toEqual({ vocabCards: 0, conjugationCards: 0, updatedCards: 1 });
    fetchImpl.mockResolvedValueOnce(ankiResponse('changed-stored.mp3')).mockResolvedValueOnce(ankiResponse(null));
    expect(await run()).toEqual({
      ...generation,
      send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
      backfill: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null },
    });
    expect(requestBodies().slice(3)).toEqual([
      { action: 'storeMediaFile', version: 6, params: { filename: 'changed.mp3', data: 'RA==' } },
      { action: 'updateNoteFields', version: 6, params: { note: {
        id: 101, fields: { Back: 'la casa / el hogar [sound:changed-stored.mp3]' },
      } } },
    ]);
    expect(await db.select({ sentAt: cards.sentAt, audioSentAt: cards.audioSentAt }).from(cards).get())
      .toEqual({ sentAt: 456, audioSentAt: 1800000000000 });
    expect(openaiLookup).not.toHaveBeenCalled();
  },
);

const backfillFailures = [
  {
    failure: 'Anki API error', status: 'failed', rejected: 1, pending: 1, message: 'note was not found: 102',
    response: () => Promise.resolve(Response.json({ result: null, error: 'note was not found: 102' })),
  },
  {
    failure: 'Anki timeout', status: 'anki_closed', rejected: 0, pending: 2, message: 'AnkiConnect request timed out: The operation timed out',
    response: () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')),
  },
  {
    failure: 'Anki refused connection', status: 'anki_closed', rejected: 0, pending: 2,
    message: 'Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: connect ECONNREFUSED',
    response: () => Promise.reject(new TypeError('connect ECONNREFUSED')),
  },
  {
    failure: 'ElevenLabs HTTP error', status: 'failed', rejected: 0, pending: 2,
    message: 'ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.',
    response: () => Promise.resolve(new Response('quota exceeded', { status: 429 })),
  },
];

test.each(backfillFailures.flatMap((failure) => (['generateFromList', 'sendPending', 'retryDeclined'] as const)
  .map((mutation) => ({ ...failure, mutation }))))(
  '$mutation preserves send and stored partial progress on $failure', async ({ mutation, failure, status, rejected, pending, message, response }) => {
    await seedHouse();
    await db.update(cards).set({ audioFile: 'first.mp3', audioMp3: Buffer.from([73]) }).where(eq(cards.id, 1));
    await db.insert(cards).values([
      { ...storedHouse, id: 2, front: 'second', ankiNoteId: 102,
        ...(failure === 'ElevenLabs HTTP error' ? {} : { audioFile: 'second.mp3', audioMp3: Buffer.from([68]) }) },
      { ...storedHouse, id: 3, front: 'new', sentAt: null, ankiNoteId: null,
        declinedAt: mutation === 'retryDeclined' ? 789 : null,
        audioFile: 'new.mp3', audioMp3: Buffer.from([51]) },
    ]);
    fetchImpl
      .mockResolvedValueOnce(ankiResponse(1))
      .mockResolvedValueOnce(ankiResponse('new.mp3'))
      .mockResolvedValueOnce(ankiResponse([103]))
      .mockResolvedValueOnce(ankiResponse(null))
      .mockResolvedValueOnce(ankiResponse('first.mp3'))
      .mockResolvedValueOnce(ankiResponse(null));
    if (failure !== 'ElevenLabs HTTP error') fetchImpl.mockResolvedValueOnce(ankiResponse('second.mp3'));
    fetchImpl.mockImplementationOnce(async () => {
      await db.insert(cards).values({ ...storedHouse, id: 4, front: 'arrived during failure', ankiNoteId: 104 });
      return response();
    });
    const caller = ankiRouter.createCaller({ headers: new Headers() });

    expect(await (mutation === 'generateFromList' ? caller.generateFromList({ text: 'casa' }) : caller[mutation]()))
      .toEqual({
        ...(mutation === 'generateFromList' ? {
          results: [{ word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 }], capReached: false,
        } : {}),
        send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 1800000000000, message: null },
        backfill: { status, sent: 1, rejected, pending, syncedAt: null, message },
      });
    expect(await db.select({ id: cards.id, sentAt: cards.sentAt, audioSentAt: cards.audioSentAt })
      .from(cards).orderBy(cards.id)).toEqual([
      { id: 1, sentAt: 456, audioSentAt: 1800000000000 },
      { id: 2, sentAt: 456, audioSentAt: null },
      { id: 3, sentAt: 1800000000000, audioSentAt: 1800000000000 },
      { id: 4, sentAt: 456, audioSentAt: null },
    ]);
    expect(openaiLookup).not.toHaveBeenCalled();
  },
);

test('the first post-migration pass counts cached audio already in Anki and does not push it on the next run', async () => {
  await seedHouse();
  await db.update(cards).set({ audioFile: 'old.mp3', audioMp3: Buffer.from([73]) }).where(eq(cards.id, 1));
  await db.insert(cards).values({
    ...storedHouse, id: 2, front: 'second', ankiNoteId: 102,
    audioFile: 'old-second.mp3', audioMp3: Buffer.from([68]),
  });
  fetchImpl
    .mockResolvedValueOnce(ankiResponse('old.mp3'))
    .mockResolvedValueOnce(ankiResponse(null))
    .mockResolvedValueOnce(ankiResponse('old-second.mp3'))
    .mockResolvedValueOnce(ankiResponse(null));
  const caller = ankiRouter.createCaller({ headers: new Headers() });

  expect(await caller.generateFromList({ text: 'casa' })).toEqual({
    results: [{ word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 }], capReached: false,
    send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
    backfill: { status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: null, message: null },
  });
  expect(await caller.generateFromList({ text: 'casa' })).toEqual({
    results: [{ word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 }], capReached: false,
    send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
    backfill: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
  });
  expect(requestBodies()).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: 'old.mp3', data: 'SQ==' } },
    { action: 'updateNoteFields', version: 6, params: { note: {
      id: 101, fields: { Back: 'la casa [sound:old.mp3]' },
    } } },
    { action: 'storeMediaFile', version: 6, params: { filename: 'old-second.mp3', data: 'RA==' } },
    { action: 'updateNoteFields', version: 6, params: { note: {
      id: 102, fields: { Back: 'la casa [sound:old-second.mp3]' },
    } } },
  ]);
  expect(await db.select({ id: cards.id, sentAt: cards.sentAt, audioSentAt: cards.audioSentAt })
    .from(cards).orderBy(cards.id)).toEqual([
    { id: 1, sentAt: 456, audioSentAt: 1800000000000 },
    { id: 2, sentAt: 456, audioSentAt: 1800000000000 },
  ]);
  expect(openaiLookup).not.toHaveBeenCalled();
});

test('sendPending still rejects an unexpected send failure without starting backfill', async () => {
  await seedHouse();
  vi.spyOn(ankiSender, 'sendPending').mockRejectedValueOnce(new Error('Unexpected send failure'));
  const caller = ankiRouter.createCaller({ headers: new Headers() });

  await expect(caller.sendPending()).rejects.toThrow('Unexpected send failure');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(await db.select().from(cards).get()).toEqual(storedHouse);
});

test.each([
  {
    failure: 'Anki API refusal', status: 'failed', message: 'deck creation refused',
    response: () => Promise.resolve(Response.json({ result: null, error: 'deck creation refused' })),
  },
  {
    failure: 'Anki timeout', status: 'anki_closed', message: 'AnkiConnect request timed out: The operation timed out',
    response: () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')),
  },
])('retryDeclined preserves the decline and stored pending count after $failure', async ({ status, message, response }) => {
  await seedHouse();
  await db.update(cards).set({ sentAt: null, ankiNoteId: null, declinedAt: 456 }).where(eq(cards.id, 1));
  fetchImpl.mockImplementationOnce(async () => {
    await db.insert(cards).values({ ...storedHouse, id: 2, front: 'arrived during failure', sentAt: null, ankiNoteId: null });
    return response();
  });
  const caller = ankiRouter.createCaller({ headers: new Headers() });

  expect(await caller.retryDeclined()).toEqual({
    send: { status, sent: 0, rejected: 0, pending: 1, syncedAt: null, message },
    backfill: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
  });
  expect(await caller.declinedCount()).toBe(1);
  expect(await caller.pendingCount()).toBe(1);
  expect(await db.select().from(cards).where(eq(cards.id, 1)).get()).toEqual({
    ...storedHouse, sentAt: null, ankiNoteId: null, declinedAt: 456,
  });
  expect(requestBodies()).toEqual([{ action: 'createDeck', version: 6, params: { deck: 'Spanish::Vocab' } }]);
});

test('retryDeclined still rejects an unexpected send result without starting backfill', async () => {
  await seedHouse();
  await db.insert(cards).values({ ...storedHouse, id: 2, front: 'declined', sentAt: null, ankiNoteId: null, declinedAt: 789 });
  fetchImpl.mockResolvedValueOnce(ankiResponse(1)).mockResolvedValueOnce(ankiResponse([]));
  const caller = ankiRouter.createCaller({ headers: new Headers() });

  await expect(caller.retryDeclined()).rejects.toThrow('AnkiConnect returned 0 results for 1 cards; check AnkiConnect and retry.');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
    storedHouse,
    { ...storedHouse, id: 2, front: 'declined', sentAt: null, ankiNoteId: null, declinedAt: 789 },
  ]);
});
