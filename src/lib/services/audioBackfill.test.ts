import { createClient, type Client } from '@libsql/client';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAnkiClient } from '@/lib/anki/ankiConnect';
import { loadConfig } from '@/lib/config';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, words } from '@/server/db/schema';
import { sendPending } from './ankiSender';
import { backfillSentAudio } from './audioBackfill';
import { storeCards } from './cardStore';
import { createSpanishVoice } from './spanishVoice';

vi.mock('@/env', () => ({
  env: { ELEVENLABS_API_KEY: 'test-api-key', ELEVENLABS_VOICE_ID: 'test-voice-id' },
}));

const url = 'http://127.0.0.1:9876';
const audioFile = 'card-39ea127757ece19e4f940e03a400b6cc3fae452580ca79223e0d6b75148a5477.mp3';
const storedHouse = {
  id: 10, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
  tags: '[]', forms: null, createdAt: 123, sentAt: 456, ankiNoteId: 101, declinedAt: null,
  audioFile: null, audioMp3: null, audioSentAt: null,
} satisfies typeof cards.$inferSelect;

let databaseClient: Client;
let db: Db;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Unexpected global fetch; inject a test fetch.');
  }));
  databaseClient = createClient({ url: ':memory:' });
  db = createDb(databaseClient);
  await applyMigrations(db);
  await db.insert(words).values({ id: 1, query: 'casa', info: '{}', lookedUpAt: 123 });
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  databaseClient.close();
});

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body');
  const body: unknown = JSON.parse(init.body);
  return body;
}

test('voices a sent card, caches its bytes, uploads and updates Back, and pushes nothing on a second run', async () => {
  await db.insert(cards).values(storedHouse);
  const voiceFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51, 0, 255])));
  const voice = createSpanishVoice(loadConfig().audio, voiceFetch);
  const ankiFetch = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => {
      expect(await db.select().from(cards).get()).toEqual({
        ...storedHouse, audioFile, audioMp3: Buffer.from([73, 68, 51, 0, 255]),
      });
      return Response.json({ result: 'stored.mp3', error: null });
    })
    .mockImplementationOnce(async () => {
      expect(await db.select({ audioSentAt: cards.audioSentAt }).from(cards).get()).toEqual({ audioSentAt: null });
      return Response.json({ result: null, error: null });
    });
  const client = createAnkiClient(url, ankiFetch);

  expect(await backfillSentAudio(db, client, voice)).toEqual({
    status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(voiceFetch).toHaveBeenCalledExactlyOnceWith(
    'https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128',
    {
      method: 'POST', headers: { 'xi-api-key': 'test-api-key', 'Content-Type': 'application/json' },
      body: '{"text":"la casa","model_id":"eleven_multilingual_v2"}',
    },
  );
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: audioFile, data: 'SUQzAP8=' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 101, fields: { Back: 'la casa [sound:stored.mp3]' } } } },
  ]);
  expect(await db.select().from(cards).get()).toEqual({
    ...storedHouse, audioFile, audioMp3: Buffer.from([73, 68, 51, 0, 255]), audioSentAt: 1800000000000,
  });
  expect(await backfillSentAudio(db, client, voice)).toEqual({
    status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(voiceFetch).toHaveBeenCalledOnce();
  expect(ankiFetch).toHaveBeenCalledTimes(2);
});

test('pushes cached audio in id order without speech and excludes rows missing send metadata or already marked', async () => {
  await db.insert(cards).values([
    { ...storedHouse, id: 20, front: 'cached', audioFile: 'second.mp3', audioMp3: Buffer.from([0, 255]), ankiNoteId: 202 },
    { ...storedHouse, audioFile: 'first.mp3', audioMp3: Buffer.from([73, 68, 51]), sentAt: 0, ankiNoteId: 0 },
    { ...storedHouse, id: 30, front: 'unsent', sentAt: null },
    { ...storedHouse, id: 40, front: 'missing id', ankiNoteId: null },
    { ...storedHouse, id: 50, front: 'current', audioSentAt: 0 },
  ]);
  const excluded = await db.select().from(cards).where(inArray(cards.id, [30, 40, 50])).orderBy(cards.id);
  const voiceFetch = vi.fn<typeof fetch>();
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'first-stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'second-stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  expect(await backfillSentAudio(db, createAnkiClient(url, ankiFetch), createSpanishVoice(loadConfig().audio, voiceFetch)))
    .toEqual({ status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: null, message: null });
  expect(voiceFetch).not.toHaveBeenCalled();
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: 'first.mp3', data: 'SUQz' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 0, fields: { Back: 'la casa [sound:first-stored.mp3]' } } } },
    { action: 'storeMediaFile', version: 6, params: { filename: 'second.mp3', data: 'AP8=' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 202, fields: { Back: 'la casa [sound:second-stored.mp3]' } } } },
  ]);
  expect(await db.select({ id: cards.id, audioSentAt: cards.audioSentAt }).from(cards)
    .where(inArray(cards.id, [10, 20])).orderBy(cards.id)).toEqual([
    { id: 10, audioSentAt: 1800000000000 }, { id: 20, audioSentAt: 1800000000000 },
  ]);
  expect(await db.select().from(cards).where(inArray(cards.id, [30, 40, 50])).orderBy(cards.id)).toEqual(excluded);
});

test('speaks plain conjugation text while pushing the stored HTML Back', async () => {
  await db.insert(cards).values({
    ...storedHouse, kind: 'conjugation', deck: 'Spanish::Conjugation',
    front: 'Conjugate hablar in present (regular -ar)', back: 'yo: hablo<br>tú: hablas',
  });
  const voiceFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([73])));
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'conjugation.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  expect(await backfillSentAudio(db, createAnkiClient(url, ankiFetch), createSpanishVoice(loadConfig().audio, voiceFetch)))
    .toEqual({ status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null });
  expect(requestBody(voiceFetch.mock.calls[0]?.[1])).toEqual({ text: 'yo: hablo tú: hablas', model_id: 'eleven_multilingual_v2' });
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: {
      filename: 'card-c601592f902a214434a7a704ad2f32fbbe719057a47ea3c26506cc66eb97ccf1.mp3', data: 'SQ==',
    } },
    { action: 'updateNoteFields', version: 6, params: { note: {
      id: 101, fields: { Back: 'yo: hablo<br>tú: hablas [sound:conjugation.mp3]' },
    } } },
  ]);
});

test('shares the existing voice budget, pushes cached audio after cap denial, and retries unvoiced cards later', async () => {
  await db.insert(cards).values([
    { ...storedHouse, id: 30, front: 'third', back: 'sí' },
    storedHouse,
    { ...storedHouse, id: 20, front: 'second', back: 'la casa' },
    { ...storedHouse, id: 40, front: 'cached', ankiNoteId: 404, audioFile: 'cached.mp3', audioMp3: Buffer.from([0, 255]) },
  ]);
  const remaining = await db.select().from(cards).where(inArray(cards.id, [20, 30])).orderBy(cards.id);
  const voiceFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(new Uint8Array([1])))
    .mockResolvedValueOnce(new Response(new Uint8Array([73])))
    .mockResolvedValueOnce(new Response(new Uint8Array([68])))
    .mockResolvedValueOnce(new Response(new Uint8Array([51])));
  const voice = createSpanishVoice(loadConfig().audio, voiceFetch);
  await voice.synthesize('a'.repeat(29990));
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'first.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'cached-stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'second.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'third.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));
  const client = createAnkiClient(url, ankiFetch);

  expect(await backfillSentAudio(db, client, voice)).toEqual({
    status: 'sent', sent: 2, rejected: 0, pending: 2, syncedAt: null, message: null,
  });
  expect(voice.dispatchedCharacters).toBe(29997);
  expect(voice.capReached).toBe(true);
  expect(voiceFetch).toHaveBeenCalledTimes(2);
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: audioFile, data: 'SQ==' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 101, fields: { Back: 'la casa [sound:first.mp3]' } } } },
    { action: 'storeMediaFile', version: 6, params: { filename: 'cached.mp3', data: 'AP8=' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 404, fields: { Back: 'la casa [sound:cached-stored.mp3]' } } } },
  ]);
  expect(await db.select({ id: cards.id, audioSentAt: cards.audioSentAt }).from(cards).orderBy(cards.id)).toEqual([
    { id: 10, audioSentAt: 1800000000000 }, { id: 20, audioSentAt: null },
    { id: 30, audioSentAt: null }, { id: 40, audioSentAt: 1800000000000 },
  ]);
  expect(await db.select().from(cards).where(inArray(cards.id, [20, 30])).orderBy(cards.id)).toEqual(remaining);
  expect(await backfillSentAudio(db, client, voice)).toEqual({
    status: 'nothing', sent: 0, rejected: 0, pending: 2, syncedAt: null, message: null,
  });
  expect(voiceFetch).toHaveBeenCalledTimes(2);
  expect(ankiFetch).toHaveBeenCalledTimes(4);
  expect(await backfillSentAudio(db, client, createSpanishVoice(loadConfig().audio, voiceFetch))).toEqual({
    status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(voiceFetch).toHaveBeenCalledTimes(4);
  expect(ankiFetch).toHaveBeenCalledTimes(8);
});

test('skips CardAudioError without failing the report, pushes following cards, and retries after text correction', async () => {
  const unsupported = { ...storedHouse, kind: 'conjugation' as const, back: 'yo: <b>hablo</b>' };
  const cached = {
    ...storedHouse, id: 20, front: 'cached', ankiNoteId: 202, audioFile: 'cached.mp3', audioMp3: Buffer.from([73]),
  };
  await db.insert(cards).values([unsupported, cached]);
  const voiceFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([68])));
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'cached.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'retry.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));
  const client = createAnkiClient(url, ankiFetch);
  const voice = createSpanishVoice(loadConfig().audio, voiceFetch);

  expect(await backfillSentAudio(db, client, voice)).toEqual({
    status: 'sent', sent: 1, rejected: 0, pending: 1, syncedAt: null, message: null,
  });
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
    unsupported, { ...cached, audioSentAt: 1800000000000 },
  ]);
  expect(voiceFetch).not.toHaveBeenCalled();
  expect(ankiFetch).toHaveBeenCalledTimes(2);

  await db.update(cards).set({ back: 'yo: hablo<br>tú: hablas' }).where(eq(cards.id, 10));
  expect(await backfillSentAudio(db, client, voice)).toEqual({
    status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(voiceFetch).toHaveBeenCalledOnce();
  expect(requestBody(voiceFetch.mock.calls[0]?.[1])).toEqual({
    text: 'yo: hablo tú: hablas', model_id: 'eleven_multilingual_v2',
  });
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: 'cached.mp3', data: 'SQ==' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 202, fields: { Back: 'la casa [sound:cached.mp3]' } } } },
    { action: 'storeMediaFile', version: 6, params: { filename: audioFile, data: 'RA==' } },
    { action: 'updateNoteFields', version: 6, params: { note: {
      id: 101, fields: { Back: 'yo: hablo<br>tú: hablas [sound:retry.mp3]' },
    } } },
  ]);
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
    {
      ...unsupported, back: 'yo: hablo<br>tú: hablas', audioFile,
      audioMp3: Buffer.from([68]), audioSentAt: 1800000000000,
    },
    { ...cached, audioSentAt: 1800000000000 },
  ]);
});

test('a closed Anki returns its observed failure and keeps generated audio cached for retry', async () => {
  await db.insert(cards).values(storedHouse);
  const voiceFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([73])));
  const ankiFetch = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('connect ECONNREFUSED 127.0.0.1:9876'))
    .mockResolvedValueOnce(Response.json({ result: 'retry.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));
  const client = createAnkiClient(url, ankiFetch);
  const voice = createSpanishVoice(loadConfig().audio, voiceFetch);

  expect(await backfillSentAudio(db, client, voice)).toEqual({
    status: 'anki_closed', sent: 0, rejected: 0, pending: 1, syncedAt: null,
    message: 'Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: connect ECONNREFUSED 127.0.0.1:9876',
  });
  expect(await db.select().from(cards).get()).toEqual({ ...storedHouse, audioFile, audioMp3: Buffer.from([73]) });
  expect(ankiFetch).toHaveBeenCalledTimes(1);
  expect(await backfillSentAudio(db, client, voice)).toEqual({
    status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(voiceFetch).toHaveBeenCalledOnce();
  expect(ankiFetch).toHaveBeenCalledTimes(3);
});

const ankiRefusals = [
  {
    failure: 'API error', message: 'note was not found: 202',
    response: () => Promise.resolve(Response.json({ result: null, error: 'note was not found: 202' })),
  },
  {
    failure: 'HTTP error', message: 'AnkiConnect returned HTTP 503 Service Unavailable',
    response: () => Promise.resolve(new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })),
  },
];

test.each(ankiRefusals.flatMap((failure) => ['storeMediaFile', 'updateNoteFields'].map((action) => ({ ...failure, action }))))(
  'continues after $action reports $failure, recounts stored progress, and retries the refused card later',
  async ({ action, message, response }) => {
    const first = { ...storedHouse, audioFile: 'first.mp3', audioMp3: Buffer.from([73]) };
    const refused = {
      ...storedHouse, id: 20, front: 'second', ankiNoteId: 202, audioFile: 'second.mp3', audioMp3: Buffer.from([68]),
    };
    const third = {
      ...storedHouse, id: 30, front: 'third', ankiNoteId: 303, audioFile: 'third.mp3', audioMp3: Buffer.from([51]),
    };
    const arrived = {
      ...storedHouse, id: 40, front: 'arrived during failure', ankiNoteId: 404,
      audioFile: 'fourth.mp3', audioMp3: Buffer.from([0, 255]),
    };
    await db.insert(cards).values([first, refused, third]);
    const voiceFetch = vi.fn<typeof fetch>();
    const ankiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: 'first-stored.mp3', error: null }))
      .mockResolvedValueOnce(Response.json({ result: null, error: null }));
    if (action === 'updateNoteFields') {
      ankiFetch.mockResolvedValueOnce(Response.json({ result: 'second-stored.mp3', error: null }));
    }
    ankiFetch.mockImplementationOnce(async () => {
      await db.insert(cards).values(arrived);
      return response();
    })
      .mockResolvedValueOnce(Response.json({ result: 'third-stored.mp3', error: null }))
      .mockResolvedValueOnce(Response.json({ result: null, error: null }));
    const client = createAnkiClient(url, ankiFetch);
    const voice = createSpanishVoice(loadConfig().audio, voiceFetch);

    expect(await backfillSentAudio(db, client, voice)).toEqual({
      status: 'failed', sent: 2, rejected: 1, pending: 1, syncedAt: null, message,
    });
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
      { ...first, audioSentAt: 1800000000000 }, refused, { ...third, audioSentAt: 1800000000000 }, arrived,
    ]);
    expect(ankiFetch.mock.calls.slice(-2).map(([, init]) => requestBody(init))).toEqual([
      { action: 'storeMediaFile', version: 6, params: { filename: 'third.mp3', data: 'Mw==' } },
      { action: 'updateNoteFields', version: 6, params: { note: { id: 303, fields: { Back: 'la casa [sound:third-stored.mp3]' } } } },
    ]);
    expect(ankiFetch).toHaveBeenCalledTimes(action === 'storeMediaFile' ? 5 : 6);
    expect(voiceFetch).not.toHaveBeenCalled();

    ankiFetch.mockClear();
    ankiFetch.mockResolvedValueOnce(Response.json({ result: 'retry.mp3', error: null }))
      .mockResolvedValueOnce(Response.json({ result: null, error: null }))
      .mockResolvedValueOnce(Response.json({ result: 'fourth-stored.mp3', error: null }))
      .mockResolvedValueOnce(Response.json({ result: null, error: null }));
    vi.mocked(Date.now).mockReturnValue(1800000001000);

    expect(await backfillSentAudio(db, client, voice)).toEqual({
      status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: null, message: null,
    });
    expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
      { action: 'storeMediaFile', version: 6, params: { filename: 'second.mp3', data: 'RA==' } },
      { action: 'updateNoteFields', version: 6, params: { note: { id: 202, fields: { Back: 'la casa [sound:retry.mp3]' } } } },
      { action: 'storeMediaFile', version: 6, params: { filename: 'fourth.mp3', data: 'AP8=' } },
      { action: 'updateNoteFields', version: 6, params: { note: { id: 404, fields: { Back: 'la casa [sound:fourth-stored.mp3]' } } } },
    ]);
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
      { ...first, audioSentAt: 1800000000000 }, { ...refused, audioSentAt: 1800000001000 },
      { ...third, audioSentAt: 1800000000000 }, { ...arrived, audioSentAt: 1800000001000 },
    ]);
    expect(voiceFetch).not.toHaveBeenCalled();
  },
);

test.each([
  {
    failure: 'another refusal', status: 'failed', sent: 1, rejected: 2, pending: 0,
    response: () => Promise.resolve(Response.json({ result: null, error: 'second note refused' })),
    markers: [{ id: 10, audioSentAt: null }, { id: 20, audioSentAt: null }, { id: 30, audioSentAt: 1800000000000 }],
    calls: 6,
  },
  {
    failure: 'a rejected fetch', status: 'failed', sent: 0, rejected: 1, pending: 2,
    response: () => Promise.reject(new TypeError('connection reset')),
    markers: [{ id: 10, audioSentAt: null }, { id: 20, audioSentAt: null }, { id: 30, audioSentAt: null }],
    calls: 4,
  },
])('keeps the first refusal message after $failure and stops only if Anki is unreachable', async ({
  status, sent, rejected, pending, response, markers, calls,
}) => {
  await db.insert(cards).values([
    { ...storedHouse, audioFile: 'first.mp3', audioMp3: Buffer.from([73]) },
    { ...storedHouse, id: 20, front: 'second', ankiNoteId: 202, audioFile: 'second.mp3', audioMp3: Buffer.from([68]) },
    { ...storedHouse, id: 30, front: 'third', ankiNoteId: 303, audioFile: 'third.mp3', audioMp3: Buffer.from([51]) },
  ]);
  const voiceFetch = vi.fn<typeof fetch>();
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'first-stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: 'note was not found: 101' }))
    .mockResolvedValueOnce(Response.json({ result: 'second-stored.mp3', error: null }))
    .mockImplementationOnce(response)
    .mockResolvedValueOnce(Response.json({ result: 'third-stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  expect(await backfillSentAudio(db, createAnkiClient(url, ankiFetch), createSpanishVoice(loadConfig().audio, voiceFetch)))
    .toEqual({ status, sent, rejected, pending, syncedAt: null, message: 'note was not found: 101' });
  expect(await db.select({ id: cards.id, audioSentAt: cards.audioSentAt }).from(cards).orderBy(cards.id)).toEqual(markers);
  expect(ankiFetch).toHaveBeenCalledTimes(calls);
  expect(voiceFetch).not.toHaveBeenCalled();
});

test.each(['storeMediaFile', 'updateNoteFields'])(
  'keeps the first voice failure status and message when %s later loses its connection', async (action) => {
    const first = { ...storedHouse, audioFile: 'first.mp3', audioMp3: Buffer.from([73]) };
    const unvoiced = { ...storedHouse, id: 20, front: 'unvoiced', ankiNoteId: 202 };
    const failed = {
      ...storedHouse, id: 30, front: 'failed', ankiNoteId: 303, audioFile: 'third.mp3', audioMp3: Buffer.from([68]),
    };
    const remaining = {
      ...storedHouse, id: 40, front: 'remaining', ankiNoteId: 404, audioFile: 'fourth.mp3', audioMp3: Buffer.from([51]),
    };
    const arrived = { ...storedHouse, id: 50, front: 'arrived during failure', ankiNoteId: 505 };
    await db.insert(cards).values([first, unvoiced, failed, remaining]);
    const voiceFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('quota exceeded', { status: 429 }));
    const ankiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: 'first-stored.mp3', error: null }))
      .mockResolvedValueOnce(Response.json({ result: null, error: null }));
    if (action === 'updateNoteFields') {
      ankiFetch.mockResolvedValueOnce(Response.json({ result: 'third-stored.mp3', error: null }));
    }
    ankiFetch.mockImplementationOnce(async () => {
      await db.insert(cards).values(arrived);
      throw new TypeError('connection reset');
    });

    expect(await backfillSentAudio(db, createAnkiClient(url, ankiFetch), createSpanishVoice(loadConfig().audio, voiceFetch)))
      .toEqual({
        status: 'failed', sent: 1, rejected: 0, pending: 4, syncedAt: null,
        message: 'ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.',
      });
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
      { ...first, audioSentAt: 1800000000000 }, unvoiced, failed, remaining, arrived,
    ]);
    expect(voiceFetch).toHaveBeenCalledOnce();
    expect(requestBody(voiceFetch.mock.calls[0]?.[1])).toEqual({ text: 'la casa', model_id: 'eleven_multilingual_v2' });
    expect(ankiFetch).toHaveBeenCalledTimes(action === 'storeMediaFile' ? 3 : 4);
    expect(requestBody(ankiFetch.mock.calls.at(-1)?.[1])).toEqual(action === 'storeMediaFile'
      ? { action: 'storeMediaFile', version: 6, params: { filename: 'third.mp3', data: 'RA==' } }
      : { action: 'updateNoteFields', version: 6, params: { note: { id: 303, fields: { Back: 'la casa [sound:third-stored.mp3]' } } } });
  },
);

const ankiFailures = [
  {
    failure: 'rejected fetch', status: 'anki_closed',
    message: 'Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: connection reset',
    response: () => Promise.reject(new TypeError('connection reset')),
  },
  {
    failure: 'timeout', status: 'anki_closed', message: 'AnkiConnect request timed out: The operation timed out',
    response: () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')),
  },
  {
    failure: 'unreadable response', status: 'anki_closed',
    message: 'AnkiConnect response (HTTP 200) could not be read: response interrupted',
    response: () => {
      const response = Response.json({ result: null, error: null });
      vi.spyOn(response, 'json').mockRejectedValueOnce(new Error('response interrupted'));
      return Promise.resolve(response);
    },
  },
];

test.each(ankiFailures.flatMap((failure) => ['storeMediaFile', 'updateNoteFields'].map((action) => ({ ...failure, action }))))(
  'recounts stored progress and stops when $action reports $failure after an earlier card commits',
  async ({ action, status, message, response }) => {
    await db.insert(cards).values([
      { ...storedHouse, audioFile: 'first.mp3', audioMp3: Buffer.from([73]) },
      { ...storedHouse, id: 20, front: 'second', ankiNoteId: 202, audioFile: 'second.mp3', audioMp3: Buffer.from([68]) },
      { ...storedHouse, id: 30, front: 'third', audioFile: 'third.mp3', audioMp3: Buffer.from([51]) },
    ]);
    const before = await db.select().from(cards).where(inArray(cards.id, [20, 30])).orderBy(cards.id);
    const voiceFetch = vi.fn<typeof fetch>();
    const ankiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: 'first-stored.mp3', error: null }))
      .mockResolvedValueOnce(Response.json({ result: null, error: null }));
    if (action === 'updateNoteFields') {
      ankiFetch.mockResolvedValueOnce(Response.json({ result: 'second-stored.mp3', error: null }));
    }
    ankiFetch.mockImplementationOnce(async () => {
      await db.insert(cards).values({ ...storedHouse, id: 40, front: 'arrived during failure' });
      return response();
    });

    expect(await backfillSentAudio(db, createAnkiClient(url, ankiFetch), createSpanishVoice(loadConfig().audio, voiceFetch)))
      .toEqual({ status, sent: 1, rejected: 0, pending: 3, syncedAt: null, message });
    expect(await db.select().from(cards).where(eq(cards.id, 10)).get()).toEqual({
      ...storedHouse, audioFile: 'first.mp3', audioMp3: Buffer.from([73]), audioSentAt: 1800000000000,
    });
    expect(await db.select().from(cards).where(inArray(cards.id, [20, 30])).orderBy(cards.id)).toEqual(before);
    expect(requestBody(ankiFetch.mock.calls.at(-1)?.[1])).toEqual(action === 'storeMediaFile'
      ? { action: 'storeMediaFile', version: 6, params: { filename: 'second.mp3', data: 'RA==' } }
      : { action: 'updateNoteFields', version: 6, params: { note: { id: 202, fields: { Back: 'la casa [sound:second-stored.mp3]' } } } });
    expect(ankiFetch).toHaveBeenCalledTimes(action === 'storeMediaFile' ? 3 : 4);
    expect(voiceFetch).not.toHaveBeenCalled();
  },
);

test.each([
  {
    failure: 'HTTP error', message: 'ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.',
    response: () => Promise.resolve(new Response('quota exceeded', { status: 429 })),
  },
  {
    failure: 'rejected fetch', message: 'speech connection reset',
    response: () => Promise.reject(new TypeError('speech connection reset')),
  },
  {
    failure: 'unreadable audio', message: 'audio body interrupted',
    response: () => {
      const response = new Response(new Uint8Array([73]));
      vi.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(new Error('audio body interrupted'));
      return Promise.resolve(response);
    },
  },
])('stops synthesis after an ElevenLabs $failure but pushes later changed audio and retries unvoiced cards next run', async ({ message, response }) => {
  const first = { ...storedHouse, audioFile: 'cached.mp3', audioMp3: Buffer.from([73]) };
  const failed = { ...storedHouse, id: 20, front: 'second', ankiNoteId: 202 };
  const unvoiced = { ...storedHouse, id: 30, front: 'third', ankiNoteId: 303 };
  const changed = { ...storedHouse, id: 40, front: 'changed', ankiNoteId: 404 };
  const arrived = { ...storedHouse, id: 50, front: 'arrived during failure', ankiNoteId: 505 };
  await db.insert(cards).values([
    first, failed, unvoiced,
    { ...changed, audioFile: 'old.mp3', audioMp3: Buffer.from([1]), audioSentAt: 789 },
  ]);
  expect(await storeCards(db, 1, [{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'changed', back: 'la casa / el hogar', tags: [],
    forms: [{ spanish: 'la casa', query: 'casa' }, { spanish: 'el hogar', query: 'hogar' }],
    audioFile: 'replacement.mp3', audioMp3: Buffer.from([73, 68, 51]),
  }], [], 40)).toEqual({ vocabCards: 0, conjugationCards: 0, updatedCards: 1 });
  const voiceFetch = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
    await db.insert(cards).values(arrived);
    return response();
  });
  const voice = createSpanishVoice(loadConfig().audio, voiceFetch);
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'replacement-stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));
  const client = createAnkiClient(url, ankiFetch);

  expect(await backfillSentAudio(db, client, voice))
    .toEqual({ status: 'failed', sent: 2, rejected: 0, pending: 3, syncedAt: null, message });
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
    { ...first, audioSentAt: 1800000000000 }, failed, unvoiced,
    {
      ...changed, back: 'la casa / el hogar',
      forms: [{ spanish: 'la casa', query: 'casa' }, { spanish: 'el hogar', query: 'hogar' }],
      audioFile: 'replacement.mp3', audioMp3: Buffer.from([73, 68, 51]), audioSentAt: 1800000000000,
    },
    arrived,
  ]);
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: 'cached.mp3', data: 'SQ==' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 101, fields: { Back: 'la casa [sound:stored.mp3]' } } } },
    { action: 'storeMediaFile', version: 6, params: { filename: 'replacement.mp3', data: 'SUQz' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 404, fields: {
      Back: 'la casa / el hogar [sound:replacement-stored.mp3]',
    } } } },
  ]);
  expect(voiceFetch).toHaveBeenCalledOnce();
  expect(voice.dispatchedCharacters).toBe(7);
  expect(voice.capReached).toBe(false);

  voiceFetch.mockImplementation(async () => new Response(new Uint8Array([68])));
  ankiFetch.mockResolvedValueOnce(Response.json({ result: 'second.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'third.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'arrived.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));
  vi.mocked(Date.now).mockReturnValue(1800000001000);

  expect(await backfillSentAudio(db, client, createSpanishVoice(loadConfig().audio, voiceFetch)))
    .toEqual({ status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: null, message: null });
  expect(await db.select({ id: cards.id, audioSentAt: cards.audioSentAt }).from(cards).orderBy(cards.id)).toEqual([
    { id: 10, audioSentAt: 1800000000000 }, { id: 20, audioSentAt: 1800000001000 },
    { id: 30, audioSentAt: 1800000001000 }, { id: 40, audioSentAt: 1800000000000 },
    { id: 50, audioSentAt: 1800000001000 },
  ]);
  expect(voiceFetch).toHaveBeenCalledTimes(4);
  expect(ankiFetch).toHaveBeenCalledTimes(10);
});

test('pushes a sent card again when storeCards replaces its audio and clears the delivery marker', async () => {
  await db.insert(cards).values({
    ...storedHouse, audioFile: 'old.mp3', audioMp3: Buffer.from([1]), audioSentAt: 789,
  });
  expect(await storeCards(db, 1, [{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa / el hogar', tags: [],
    forms: [{ spanish: 'la casa', query: 'casa' }, { spanish: 'el hogar', query: 'hogar' }],
    audioFile: 'replacement.mp3', audioMp3: Buffer.from([73, 68, 51]),
  }], [], 10)).toEqual({ vocabCards: 0, conjugationCards: 0, updatedCards: 1 });
  const voiceFetch = vi.fn<typeof fetch>();
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'replacement-stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  expect(await backfillSentAudio(db, createAnkiClient(url, ankiFetch), createSpanishVoice(loadConfig().audio, voiceFetch)))
    .toEqual({ status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null });
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: 'replacement.mp3', data: 'SUQz' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 101, fields: {
      Back: 'la casa / el hogar [sound:replacement-stored.mp3]',
    } } } },
  ]);
  expect(await db.select({ audioSentAt: cards.audioSentAt, sentAt: cards.sentAt }).from(cards).get())
    .toEqual({ audioSentAt: 1800000000000, sentAt: 456 });
  expect(voiceFetch).not.toHaveBeenCalled();
});

test('does not backfill a card whose audio was delivered by sendPending', async () => {
  await db.insert(cards).values({
    ...storedHouse, sentAt: null, ankiNoteId: null, audioFile: 'cached.mp3', audioMp3: Buffer.from([73]),
  });
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 1, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'cached.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: [101], error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));
  const client = createAnkiClient(url, ankiFetch);
  expect(await sendPending(db, client)).toEqual({
    status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 1800000000000, message: null,
  });
  const voiceFetch = vi.fn<typeof fetch>();

  expect(await backfillSentAudio(db, client, createSpanishVoice(loadConfig().audio, voiceFetch))).toEqual({
    status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(ankiFetch).toHaveBeenCalledTimes(4);
  expect(voiceFetch).not.toHaveBeenCalled();
});

test('voices and pushes a sent fold whose changed Back cleared old audio after cap denial', async () => {
  await db.insert(cards).values({
    ...storedHouse, audioFile: 'old.mp3', audioMp3: Buffer.from([1]), audioSentAt: 789,
  });
  expect(await storeCards(db, 1, [{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa / el hogar', tags: [],
    forms: [{ spanish: 'la casa', query: 'casa' }, { spanish: 'el hogar', query: 'hogar' }],
  }], [], 10)).toEqual({ vocabCards: 0, conjugationCards: 0, updatedCards: 1 });
  expect(await db.select({ audioFile: cards.audioFile, audioMp3: cards.audioMp3, audioSentAt: cards.audioSentAt })
    .from(cards).get()).toEqual({ audioFile: null, audioMp3: null, audioSentAt: null });
  const voiceFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([73, 68])));
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'folded.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  expect(await backfillSentAudio(db, createAnkiClient(url, ankiFetch), createSpanishVoice(loadConfig().audio, voiceFetch)))
    .toEqual({ status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null });
  expect(requestBody(voiceFetch.mock.calls[0]?.[1])).toEqual({ text: 'la casa / el hogar', model_id: 'eleven_multilingual_v2' });
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: audioFile, data: 'SUQ=' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 101, fields: {
      Back: 'la casa / el hogar [sound:folded.mp3]',
    } } } },
  ]);
  expect(await db.select({
    audioFile: cards.audioFile, audioMp3: cards.audioMp3, audioSentAt: cards.audioSentAt, sentAt: cards.sentAt,
  }).from(cards).get()).toEqual({ audioFile, audioMp3: Buffer.from([73, 68]), audioSentAt: 1800000000000, sentAt: 456 });
});

test('pushes conflict-filled audio on a sent row without another speech request', async () => {
  await db.insert(cards).values(storedHouse);
  expect(await storeCards(db, 1, [{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa', tags: [],
    audioFile: 'filled.mp3', audioMp3: Buffer.from([73, 68]),
  }], [])).toEqual({ vocabCards: 0, conjugationCards: 0, updatedCards: 0 });
  const voiceFetch = vi.fn<typeof fetch>();
  const ankiFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 'filled-stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  expect(await backfillSentAudio(db, createAnkiClient(url, ankiFetch), createSpanishVoice(loadConfig().audio, voiceFetch)))
    .toEqual({ status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null });
  expect(ankiFetch.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'storeMediaFile', version: 6, params: { filename: 'filled.mp3', data: 'SUQ=' } },
    { action: 'updateNoteFields', version: 6, params: { note: { id: 101, fields: { Back: 'la casa [sound:filled-stored.mp3]' } } } },
  ]);
  expect(await db.select().from(cards).get()).toEqual({
    ...storedHouse, audioFile: 'filled.mp3', audioMp3: Buffer.from([73, 68]), audioSentAt: 1800000000000,
  });
  expect(voiceFetch).not.toHaveBeenCalled();
});
