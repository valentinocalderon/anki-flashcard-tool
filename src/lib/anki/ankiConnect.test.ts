import { createClient } from '@libsql/client';
import { expect, test, vi } from 'vitest';
import type * as AnkiSender from '@/lib/services/ankiSender';
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
  result: number | (number | null)[] | null;
  expected: number | (number | null)[] | undefined;
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

test.each(actions)('$action reports a rejected fetch as Anki not running', async (action) => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'));
  const result = action.invoke(createAnkiClient(url, fetchImpl));

  await expect(result).rejects.toBeInstanceOf(AnkiUnreachableError);
  await expect(result).rejects.toThrow('Anki is not running');
});

test.each(actions)('$action reports a timed out fetch with its cause', async (action) => {
  const cause = new DOMException('The operation timed out', 'TimeoutError');
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(cause);
  const result = action.invoke(createAnkiClient(url, fetchImpl));

  await expect(result).rejects.toBeInstanceOf(AnkiUnreachableError);
  await expect(result).rejects.toThrow('Anki did not answer in time');
  await expect(result).rejects.toHaveProperty('cause', cause);
});

test.each(actions)('$action reports a non-JSON body as unreachable with its cause', async (action) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
    new Response('<html>AnkiConnect is unavailable</html>'),
  );
  const result = action.invoke(createAnkiClient(url, fetchImpl));

  await expect(result).rejects.toBeInstanceOf(AnkiUnreachableError);
  await expect(result).rejects.toThrow('Anki is not running');
  await expect(result).rejects.toHaveProperty('cause', expect.any(SyntaxError));
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
    vi.doMock('@/server/db', () => ({ getDb: () => Promise.resolve(db) }));
    vi.doMock('@/lib/services/aiLookup', () => ({ openaiLookup: vi.fn() }));
    vi.doMock('@/lib/services/listGenerationService', () => ({
      generateForWords: vi.fn().mockResolvedValue(results),
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
      send: {
        status: 'failed', sent: 0, rejected: 0, pending: 1,
        syncedAt: null, message: error.message,
      },
    });
  } finally {
    vi.doUnmock('@/server/db');
    vi.doUnmock('@/lib/services/aiLookup');
    vi.doUnmock('@/lib/services/listGenerationService');
    vi.doUnmock('@/lib/services/ankiSender');
    databaseClient.close();
  }
});
