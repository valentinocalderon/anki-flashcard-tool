import { createClient } from '@libsql/client';
import { expect, test, vi } from 'vitest';
import type * as AnkiSender from '@/lib/services/ankiSender';
import type { generateForWords } from '@/lib/services/listGenerationService';
import type { WordResult } from '@/lib/types';
import { applyMigrations, createDb } from '@/server/db';
import { cards, words } from '@/server/db/schema';
import {
  AnkiConnectError,
  AnkiUnreachableError,
  createAnkiClient,
  type AnkiClient,
  type AnkiNote,
} from './ankiConnect';

const url = 'http://127.0.0.1:9876';
const note: AnkiNote = {
  deckName: 'Spanish::Vocab',
  modelName: 'Basic (and reversed card)',
  fields: { Front: 'house', Back: 'la casa' },
  tags: ['auto-generated'],
  options: { allowDuplicate: false, duplicateScope: 'deck' },
};

const actions: {
  action: string;
  params: Record<string, unknown>;
  result: string | number | (number | null)[] | null;
  expected: string | number | (number | null)[] | undefined;
  invoke: (client: AnkiClient) => Promise<unknown>;
}[] = [
  {
    action: 'createDeck', params: { deck: 'Spanish::Vocab' }, result: 123, expected: 123,
    invoke: (client) => client.createDeck('Spanish::Vocab'),
  },
  {
    action: 'addNotes', params: { notes: [note, note] }, result: [456, null], expected: [456, null],
    invoke: (client) => client.addNotes([note, note]),
  },
  {
    action: 'storeMediaFile', params: { filename: 'casa.mp3', data: 'SUQzAP8=' },
    result: 'casa.mp3', expected: 'casa.mp3',
    invoke: (client) => client.storeMediaFile('casa.mp3', Buffer.from([73, 68, 51, 0, 255])),
  },
  {
    action: 'updateNoteFields', params: { note: { id: 456, fields: { Back: 'la casa [sound:casa.mp3]' } } },
    result: null, expected: undefined,
    invoke: (client) => client.updateNoteFields(456, { Back: 'la casa [sound:casa.mp3]' }),
  },
  {
    action: 'sync', params: {}, result: null, expected: undefined,
    invoke: (client) => client.sync(),
  },
];

test.each(actions)('$action posts a version 6 JSON request and returns its result', async (action) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json({ result: action.result, error: null }),
  );
  const client = createAnkiClient(url, fetchImpl);

  await expect(action.invoke(client)).resolves.toEqual(action.expected);
  const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action.action, version: 6, params: action.params }),
    signal,
  });
});

test.each([null, 123, '', { filename: 'casa.mp3' }])(
  'storeMediaFile rejects an invalid filename result: %j',
  async (result) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result, error: null }));

    await expect(createAnkiClient(url, fetchImpl).storeMediaFile('casa.mp3', Buffer.from([73, 68, 51])))
      .rejects.toHaveProperty('name', 'ZodError');
  },
);

test.each(actions)('$action throws AnkiConnectError with the API error text', async (action) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json({ result: null, error: 'AnkiConnect action failed' }),
  );
  const result = action.invoke(createAnkiClient(url, fetchImpl));

  await expect(result).rejects.toBeInstanceOf(AnkiConnectError);
  await expect(result).rejects.toThrow('AnkiConnect action failed');
});

test('an empty error string still throws AnkiConnectError', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json({ result: null, error: '' }),
  );
  const result = createAnkiClient(url, fetchImpl).sync();

  await expect(result).rejects.toBeInstanceOf(AnkiConnectError);
  await expect(result).rejects.toHaveProperty('message', '');
});

test.each(actions)('$action reports a rejected fetch and preserves its cause', async (action) => {
  const cause = new TypeError('fetch failed');
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(cause);
  const result = action.invoke(createAnkiClient(url, fetchImpl));

  await expect(result).rejects.toBeInstanceOf(AnkiUnreachableError);
  await expect(result).rejects.toHaveProperty('message',
    'Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: fetch failed');
  await expect(result).rejects.toHaveProperty('cause', cause);
});

test.each([0, '', {}, []].map((result) => ({ result })))('updateNoteFields rejects a non-null result: $result', async ({ result }) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result, error: null }));

  await expect(createAnkiClient(url, fetchImpl).updateNoteFields(456, { Back: 'la casa' }))
    .rejects.toHaveProperty('name', 'ZodError');
});

test.each(actions)('$action reports a timed out fetch with its cause', async (action) => {
  const cause = new DOMException('The operation timed out', 'TimeoutError');
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(cause);
  const result = action.invoke(createAnkiClient(url, fetchImpl));

  await expect(result).rejects.toBeInstanceOf(AnkiUnreachableError);
  await expect(result).rejects.toHaveProperty('message', 'AnkiConnect request timed out: The operation timed out');
  await expect(result).rejects.toHaveProperty('cause', cause);
});

test.each(actions)('$action reports a non-JSON body as unreachable with its cause', async (action) => {
  const cause = new SyntaxError('Unexpected token <');
  const response = new Response('<html>AnkiConnect is unavailable</html>');
  vi.spyOn(response, 'json').mockRejectedValueOnce(cause);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  const result = action.invoke(createAnkiClient(url, fetchImpl));

  await expect(result).rejects.toBeInstanceOf(AnkiUnreachableError);
  await expect(result).rejects.toHaveProperty('message', 'AnkiConnect response (HTTP 200) could not be read: Unexpected token <');
  await expect(result).rejects.toHaveProperty('cause', cause);
});

test.each(actions)('$action reports a failing HTTP status before decoding the body', async (action) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
    new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }),
  );
  const result = action.invoke(createAnkiClient(url, fetchImpl));

  await expect(result).rejects.toBeInstanceOf(AnkiConnectError);
  await expect(result).rejects.toHaveProperty('message', 'AnkiConnect returned HTTP 503 Service Unavailable');
});

test('an unexpected send failure preserves word results and counts only pending cards', async () => {
  const databaseClient = createClient({ url: ':memory:' });
  const db = createDb(databaseClient);
  const results: WordResult[] = [
    { word: 'casa', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ];
  const error = new Error('Unexpected send failure');
  try {
    await applyMigrations(db);
    const word = await db.insert(words).values({
      query: 'casa', info: '{}', lookedUpAt: 1,
    }).returning({ id: words.id }).get();
    await db.insert(cards).values([
      { front: 'pending', sentAt: null, declinedAt: null },
      { front: 'declined', sentAt: null, declinedAt: 0 },
      { front: 'sent', sentAt: 1, declinedAt: null },
    ].map((card) => ({
      ...card, wordId: word.id, deck: 'Spanish::Vocab', kind: 'basic' as const,
      back: 'la casa', tags: '[]', createdAt: 1,
    })));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected network request')));
    vi.doMock('@/env', () => ({ env: {
      OPENAI_API_KEY: 'test-key', ELEVENLABS_API_KEY: 'test-api-key', ELEVENLABS_VOICE_ID: 'test-voice-id',
    } }));
    vi.doMock('@/server/db', () => ({ getDb: () => Promise.resolve(db) }));
    vi.doMock('@/lib/services/aiLookup', () => ({ openaiLookup: vi.fn() }));
    vi.doMock('@/lib/services/listGenerationService', () => ({
      generateForWords: vi.fn<typeof generateForWords>().mockImplementation(async (...args) => {
        await args[4].synthesize('a'.repeat(30001));
        return { results, capReached: true, audio: { unspeakable: 0, message: null } };
      }),
    }));
    vi.doMock('@/lib/services/ankiSender', async (importOriginal) => ({
      ...await importOriginal<typeof AnkiSender>(),
      sendPending: vi.fn().mockRejectedValue(error),
    }));
    const { ankiRouter } = await import('@/server/api/routers/lookupRouter');
    const caller = ankiRouter.createCaller({ headers: new Headers() });

    expect(await caller.pendingCount()).toBe(1);
    expect(await caller.generateFromList({ text: 'casa' })).toEqual({
      results,
      capReached: true, audio: { unspeakable: 0, message: null },
      send: {
        status: 'failed', sent: 0, rejected: 0, pending: 1,
        syncedAt: null, message: 'Unexpected send failure',
      },
      backfill: { status: 'nothing', sent: 0, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null },
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.doUnmock('@/env');
    vi.doUnmock('@/server/db');
    vi.doUnmock('@/lib/services/aiLookup');
    vi.doUnmock('@/lib/services/listGenerationService');
    vi.doUnmock('@/lib/services/ankiSender');
    databaseClient.close();
  }
});
