import { createClient, type Client } from '@libsql/client';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AnkiConnectError, AnkiUnreachableError, createAnkiClient, type AnkiClient } from '@/lib/anki/ankiConnect';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, words } from '@/server/db/schema';
import { declinedCount, retryDeclined, sendPending, type SendReport } from './ankiSender';

const now = 1_800_000_000_000;
const pendingCards = [
  {
    id: 30, deck: 'Spanish::Conjugation', kind: 'conjugation',
    front: 'Conjugate hablar', back: 'yo: hablo', tags: '["conjugation"]',
  },
  {
    id: 10, deck: 'Spanish::Vocab', kind: 'basic',
    front: 'house', back: 'la casa', tags: '["auto-generated","vocab"]',
  },
  {
    id: 20, deck: 'Spanish::Vocab', kind: 'example',
    front: 'La ____ es grande.', back: 'casa (house)', tags: '[]',
  },
] satisfies Omit<typeof cards.$inferInsert, 'wordId' | 'createdAt'>[];

function fakeClient(results: (number | null)[]) {
  const calls: (keyof AnkiClient)[] = [];
  const client = {
    createDeck: vi.fn<AnkiClient['createDeck']>(async () => {
      calls.push('createDeck');
      return 1;
    }),
    storeMediaFile: vi.fn<AnkiClient['storeMediaFile']>(async (filename) => {
      calls.push('storeMediaFile');
      return filename;
    }),
    addNotes: vi.fn<AnkiClient['addNotes']>(async () => {
      calls.push('addNotes');
      return results;
    }),
    updateNoteFields: vi.fn<AnkiClient['updateNoteFields']>(),
    sync: vi.fn<AnkiClient['sync']>(async () => {
      calls.push('sync');
    }),
  } satisfies AnkiClient;
  return { client, calls };
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body');
  const body: unknown = JSON.parse(init.body);
  return body;
}

let databaseClient: Client;
let db: Db;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  databaseClient = createClient({ url: ':memory:' });
  db = createDb(databaseClient);
  await applyMigrations(db);
  const word = await db.insert(words).values({
    query: 'test', info: '{}', lookedUpAt: now - 100,
  }).returning({ id: words.id }).get();
  await db.insert(cards).values([
    ...pendingCards.map((card) => ({ ...card, wordId: word.id, createdAt: now - 100 })),
    {
      id: 15, wordId: word.id, deck: 'Already sent', kind: 'basic',
      front: 'old', back: 'viejo', tags: '[]', createdAt: now - 100,
      ankiNoteId: 99, sentAt: now - 50,
    },
    {
      id: 25, wordId: word.id, deck: 'Already rejected', kind: 'basic',
      front: 'duplicate', back: 'duplicado', tags: '[]', createdAt: now - 100,
      ankiNoteId: null, sentAt: now - 50,
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  databaseClient.close();
});

test.each([
  { id: 10, kind: 'basic', backs: ['la casa [sound:stored.mp3]', 'casa (house)', 'yo: hablo'] },
  { id: 20, kind: 'example', backs: ['la casa', 'casa (house) [sound:stored.mp3]', 'yo: hablo'] },
  { id: 30, kind: 'conjugation', backs: ['la casa', 'casa (house)', 'yo: hablo [sound:stored.mp3]'] },
])('uploads cached $kind audio before addNotes and uses the returned filename on Back', async ({ id, backs }) => {
  await db.update(cards).set({ audioFile: 'cached.mp3', audioMp3: Buffer.from([73, 68, 51, 0, 255]) })
    .where(inArray(cards.id, [id, 15, 25]));
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 1, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 2, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'stored.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: [101, 102, 103], error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));
  const client = createAnkiClient('http://127.0.0.1:9876', fetchImpl);

  expect(await sendPending(db, client)).toEqual({
    status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: 1800000000000, message: null,
  });
  const requests = fetchImpl.mock.calls.map(([, init]) => requestBody(init));
  expect(requests).toEqual([
    { action: 'createDeck', version: 6, params: { deck: 'Spanish::Vocab' } },
    { action: 'createDeck', version: 6, params: { deck: 'Spanish::Conjugation' } },
    { action: 'storeMediaFile', version: 6, params: { filename: 'cached.mp3', data: 'SUQzAP8=' } },
    { action: 'addNotes', version: 6, params: { notes: [
      {
        deckName: 'Spanish::Vocab', modelName: 'Basic (and reversed card)',
        fields: { Front: 'house', Back: backs[0] }, tags: ['auto-generated', 'vocab'],
        options: { allowDuplicate: false, duplicateScope: 'deck' },
      },
      {
        deckName: 'Spanish::Vocab', modelName: 'Basic',
        fields: { Front: 'La ____ es grande.', Back: backs[1] }, tags: [],
        options: { allowDuplicate: false, duplicateScope: 'deck' },
      },
      {
        deckName: 'Spanish::Conjugation', modelName: 'Basic',
        fields: { Front: 'Conjugate hablar', Back: backs[2] }, tags: ['conjugation'],
        options: { allowDuplicate: false, duplicateScope: 'deck' },
      },
    ] } },
    { action: 'sync', version: 6, params: {} },
  ]);
  expect(await db.select({ back: cards.back }).from(cards).where(eq(cards.id, 10)).get())
    .toEqual({ back: 'la casa' });
  expect(await db.select({ audioSentAt: cards.audioSentAt }).from(cards).where(eq(cards.id, id)).get())
    .toEqual({ audioSentAt: 1800000000000 });
  expect(await db.select({ audioSentAt: cards.audioSentAt }).from(cards)
    .where(inArray(cards.id, [15, 25])).orderBy(cards.id)).toEqual([
    { audioSentAt: null }, { audioSentAt: null },
  ]);
  expect(await sendPending(db, client)).toEqual({
    status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(5);
});

test('sends cards without cached audio unchanged through the injected fetch', async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 1, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 2, error: null }))
    .mockResolvedValueOnce(Response.json({ result: [101, 102, 103], error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  expect(await sendPending(db, createAnkiClient('http://127.0.0.1:9876', fetchImpl))).toEqual({
    status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: 1800000000000, message: null,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(await db.select({ audioSentAt: cards.audioSentAt }).from(cards)
    .where(inArray(cards.id, [10, 20, 30])).orderBy(cards.id)).toEqual([
    { audioSentAt: null }, { audioSentAt: null }, { audioSentAt: null },
  ]);
  expect(requestBody(fetchImpl.mock.calls[2]?.[1])).toEqual({
    action: 'addNotes', version: 6, params: { notes: [
      {
        deckName: 'Spanish::Vocab', modelName: 'Basic (and reversed card)',
        fields: { Front: 'house', Back: 'la casa' }, tags: ['auto-generated', 'vocab'],
        options: { allowDuplicate: false, duplicateScope: 'deck' },
      },
      {
        deckName: 'Spanish::Vocab', modelName: 'Basic',
        fields: { Front: 'La ____ es grande.', Back: 'casa (house)' }, tags: [],
        options: { allowDuplicate: false, duplicateScope: 'deck' },
      },
      {
        deckName: 'Spanish::Conjugation', modelName: 'Basic',
        fields: { Front: 'Conjugate hablar', Back: 'yo: hablo' }, tags: ['conjugation'],
        options: { allowDuplicate: false, duplicateScope: 'deck' },
      },
    ] },
  });
});

test.each([
  {
    failure: 'API error', status: 'failed', message: 'Media write failed: disk full',
    response: () => Promise.resolve(Response.json({ result: null, error: 'Media write failed: disk full' })),
  },
  {
    failure: 'rejected fetch', status: 'anki_closed',
    message: 'Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: fetch failed',
    response: () => Promise.reject(new TypeError('fetch failed')),
  },
  {
    failure: 'timeout', status: 'anki_closed', message: 'AnkiConnect request timed out: The operation timed out',
    response: () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')),
  },
  {
    failure: 'HTTP error', status: 'failed', message: 'AnkiConnect returned HTTP 503 Service Unavailable',
    response: () => Promise.resolve(new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })),
  },
  {
    failure: 'response read error', status: 'anki_closed',
    message: 'AnkiConnect response (HTTP 200) could not be read: response interrupted',
    response: () => {
      const response = Response.json({ result: 'second.mp3', error: null });
      vi.spyOn(response, 'json').mockRejectedValueOnce(new Error('response interrupted'));
      return Promise.resolve(response);
    },
  },
])('keeps every card pending after one upload succeeds and the next reports $failure', async ({ status, message, response }) => {
  await db.update(cards).set({ audioFile: 'first.mp3', audioMp3: Buffer.from([73, 68, 51]) })
    .where(eq(cards.id, 10));
  await db.update(cards).set({ audioFile: 'second.mp3', audioMp3: Buffer.from([0, 255]) })
    .where(eq(cards.id, 20));
  const before = await db.select().from(cards).orderBy(cards.id);
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 1, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 2, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'first.mp3', error: null }))
    .mockImplementationOnce(response);

  expect(await sendPending(db, createAnkiClient('http://127.0.0.1:9876', fetchImpl))).toEqual({
    status, sent: 0, rejected: 0, pending: 3, syncedAt: null, message,
  });
  expect(fetchImpl.mock.calls.map(([, init]) => requestBody(init))).toEqual([
    { action: 'createDeck', version: 6, params: { deck: 'Spanish::Vocab' } },
    { action: 'createDeck', version: 6, params: { deck: 'Spanish::Conjugation' } },
    { action: 'storeMediaFile', version: 6, params: { filename: 'first.mp3', data: 'SUQz' } },
    { action: 'storeMediaFile', version: 6, params: { filename: 'second.mp3', data: 'AP8=' } },
  ]);
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
});

test('propagates an invalid upload result without adding notes or changing cards', async () => {
  await db.update(cards).set({ audioFile: 'cached.mp3', audioMp3: Buffer.from([73, 68, 51]) })
    .where(eq(cards.id, 10));
  const before = await db.select().from(cards).orderBy(cards.id);
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 1, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 2, error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  await expect(sendPending(db, createAnkiClient('http://127.0.0.1:9876', fetchImpl)))
    .rejects.toHaveProperty('name', 'ZodError');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(requestBody(fetchImpl.mock.calls[2]?.[1])).toEqual({
    action: 'storeMediaFile', version: 6, params: { filename: 'cached.mp3', data: 'SUQz' },
  });
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
});

test.each([
  {
    failure: 'API error', message: 'AnkiWeb sync failed',
    response: () => Promise.resolve(Response.json({ result: null, error: 'AnkiWeb sync failed' })),
  },
  {
    failure: 'rejected fetch',
    message: 'Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: connection reset',
    response: () => Promise.reject(new TypeError('connection reset')),
  },
])('reads current counts after audio notes commit and sync reports $failure', async ({ message, response }) => {
  await db.update(cards).set({ audioFile: 'cached.mp3', audioMp3: Buffer.from([73, 68, 51]) })
    .where(eq(cards.id, 10));
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 1, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 2, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'cached.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: [101, null, 103], error: null }))
    .mockImplementationOnce(async () => {
      await db.insert(cards).values({
        id: 40, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic',
        front: 'new', back: 'nuevo', tags: '[]', createdAt: 1800000000000,
      });
      return response();
    });

  expect(await sendPending(db, createAnkiClient('http://127.0.0.1:9876', fetchImpl))).toEqual({
    status: 'sent', sent: 2, rejected: 1, pending: 1, syncedAt: null, message,
  });
  expect(await db.select({
    id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt, declinedAt: cards.declinedAt,
    audioSentAt: cards.audioSentAt,
  }).from(cards).where(inArray(cards.id, [10, 20, 30, 40])).orderBy(cards.id)).toEqual([
    { id: 10, ankiNoteId: 101, sentAt: 1800000000000, declinedAt: null, audioSentAt: 1800000000000 },
    { id: 20, ankiNoteId: null, sentAt: null, declinedAt: 1800000000000, audioSentAt: null },
    { id: 30, ankiNoteId: 103, sentAt: 1800000000000, declinedAt: null, audioSentAt: null },
    { id: 40, ankiNoteId: null, sentAt: null, declinedAt: null, audioSentAt: null },
  ]);
  expect(fetchImpl).toHaveBeenCalledTimes(5);
});

test('marks audio only for accepted notes when uploaded audio accompanies a declined note', async () => {
  await db.update(cards).set({ audioFile: 'cached.mp3', audioMp3: Buffer.from([73, 68, 51]) })
    .where(inArray(cards.id, [10, 20]));
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 1, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 2, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'cached.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'cached.mp3', error: null }))
    .mockResolvedValueOnce(Response.json({ result: [101, null, 103], error: null }))
    .mockResolvedValueOnce(Response.json({ result: null, error: null }));

  expect(await sendPending(db, createAnkiClient('http://127.0.0.1:9876', fetchImpl))).toEqual({
    status: 'sent', sent: 2, rejected: 1, pending: 0, syncedAt: 1800000000000, message: null,
  });
  expect(await db.select({ id: cards.id, audioSentAt: cards.audioSentAt }).from(cards)
    .where(inArray(cards.id, [10, 20, 30])).orderBy(cards.id)).toEqual([
    { id: 10, audioSentAt: 1800000000000 }, { id: 20, audioSentAt: null }, { id: 30, audioSentAt: null },
  ]);
  expect(fetchImpl).toHaveBeenCalledTimes(6);
});

test.each([
  {
    status: 'failed', message: 'addNotes failed',
    response: () => Promise.resolve(Response.json({ result: null, error: 'addNotes failed' })),
  },
  {
    status: 'anki_closed',
    message: 'Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: connection reset',
    response: () => Promise.reject(new TypeError('connection reset')),
  },
])('does not mark uploaded audio when addNotes reports $status', async ({ status, message, response }) => {
  await db.update(cards).set({ audioFile: 'cached.mp3', audioMp3: Buffer.from([73, 68, 51]) })
    .where(eq(cards.id, 10));
  const before = await db.select().from(cards).orderBy(cards.id);
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: 1, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 2, error: null }))
    .mockResolvedValueOnce(Response.json({ result: 'cached.mp3', error: null }))
    .mockImplementationOnce(response);

  expect(await sendPending(db, createAnkiClient('http://127.0.0.1:9876', fetchImpl))).toEqual({
    status, sent: 0, rejected: 0, pending: 3, syncedAt: null, message,
  });
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

test('sends pending cards in id order with configured note types, creates each deck once, and syncs', async () => {
  const { client, calls } = fakeClient([101, 102, 103]);
  const report: SendReport = await sendPending(db, client);

  expect(report).toEqual({ status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: now, message: null });
  expect(calls).toEqual(['createDeck', 'createDeck', 'addNotes', 'sync']);
  expect(client.createDeck.mock.calls).toEqual([['Spanish::Vocab'], ['Spanish::Conjugation']]);
  expect(client.addNotes).toHaveBeenCalledExactlyOnceWith([
    {
      deckName: 'Spanish::Vocab', modelName: 'Basic (and reversed card)',
      fields: { Front: 'house', Back: 'la casa' }, tags: ['auto-generated', 'vocab'],
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    },
    {
      deckName: 'Spanish::Vocab', modelName: 'Basic',
      fields: { Front: 'La ____ es grande.', Back: 'casa (house)' }, tags: [],
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    },
    {
      deckName: 'Spanish::Conjugation', modelName: 'Basic',
      fields: { Front: 'Conjugate hablar', Back: 'yo: hablo' }, tags: ['conjugation'],
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    },
  ]);
  expect(client.sync).toHaveBeenCalledExactlyOnceWith();
  expect(await db.select({ id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt })
    .from(cards).orderBy(cards.id)).toEqual([
    { id: 10, ankiNoteId: 101, sentAt: now },
    { id: 15, ankiNoteId: 99, sentAt: now - 50 },
    { id: 20, ankiNoteId: 102, sentAt: now },
    { id: 25, ankiNoteId: null, sentAt: now - 50 },
    { id: 30, ankiNoteId: 103, sentAt: now },
  ]);
});

test('marks a null result declined with sentAt null and does not send it again', async () => {
  const { client } = fakeClient([101, null, 103]);

  expect(await sendPending(db, client)).toEqual({
    status: 'sent', sent: 2, rejected: 1, pending: 0, syncedAt: now, message: null,
  });
  expect(await db.select({
    id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt, declinedAt: cards.declinedAt,
  })
    .from(cards).orderBy(cards.id)).toEqual([
    { id: 10, ankiNoteId: 101, sentAt: now, declinedAt: null },
    { id: 15, ankiNoteId: 99, sentAt: now - 50, declinedAt: null },
    { id: 20, ankiNoteId: null, sentAt: null, declinedAt: now },
    { id: 25, ankiNoteId: null, sentAt: now - 50, declinedAt: null },
    { id: 30, ankiNoteId: 103, sentAt: now, declinedAt: null },
  ]);
  expect(client.sync).toHaveBeenCalledOnce();
  expect(await sendPending(db, client)).toEqual({
    status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(client.addNotes).toHaveBeenCalledOnce();
  expect(client.sync).toHaveBeenCalledOnce();
});

test('excludes recorded declines while sending pending cards', async () => {
  await db.update(cards).set({ sentAt: null, declinedAt: now - 50 }).where(eq(cards.id, 25));
  const before = await db.select().from(cards).where(eq(cards.id, 25)).get();
  const { client } = fakeClient([101, 102, 103]);

  expect(await sendPending(db, client)).toEqual({
    status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: now, message: null,
  });
  expect(client.addNotes.mock.calls[0]?.[0].map((note) => note.fields.Front)).toEqual([
    'house', 'La ____ es grande.', 'Conjugate hablar',
  ]);
  expect(client.createDeck).not.toHaveBeenCalledWith('Already rejected');
  expect(await db.select().from(cards).where(eq(cards.id, 25)).get()).toEqual(before);
});

test('retryDeclined clears every decline and sends those cards with pending cards', async () => {
  await db.update(cards).set({ declinedAt: now - 50 }).where(inArray(cards.id, [10, 20]));
  const { client } = fakeClient([101, 102, 103]);

  expect(await retryDeclined(db, client)).toEqual({
    status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: now, message: null,
  });
  expect(client.addNotes.mock.calls[0]?.[0].map((note) => note.fields.Front)).toEqual([
    'house', 'La ____ es grande.', 'Conjugate hablar',
  ]);
  expect(await db.select({
    id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt, declinedAt: cards.declinedAt,
  }).from(cards).orderBy(cards.id)).toEqual([
    { id: 10, ankiNoteId: 101, sentAt: now, declinedAt: null },
    { id: 15, ankiNoteId: 99, sentAt: now - 50, declinedAt: null },
    { id: 20, ankiNoteId: 102, sentAt: now, declinedAt: null },
    { id: 25, ankiNoteId: null, sentAt: now - 50, declinedAt: null },
    { id: 30, ankiNoteId: 103, sentAt: now, declinedAt: null },
  ]);
  expect(client.sync).toHaveBeenCalledExactlyOnceWith();
  expect(await declinedCount(db)).toBe(0);
});

test('retryDeclined resends declined cards and a second null records a new decline', async () => {
  const first = fakeClient([101, null, null]);
  expect(await sendPending(db, first.client)).toEqual({
    status: 'sent', sent: 1, rejected: 2, pending: 0, syncedAt: now, message: null,
  });
  vi.mocked(Date.now).mockReturnValue(now + 100);
  const { client } = fakeClient([null, 203]);

  expect(await retryDeclined(db, client)).toEqual({
    status: 'sent', sent: 1, rejected: 1, pending: 0, syncedAt: now + 100, message: null,
  });
  expect(client.addNotes.mock.calls[0]?.[0].map((note) => note.fields.Front)).toEqual([
    'La ____ es grande.', 'Conjugate hablar',
  ]);
  expect(await db.select({
    id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt, declinedAt: cards.declinedAt,
  }).from(cards).where(inArray(cards.id, [20, 30])).orderBy(cards.id)).toEqual([
    { id: 20, ankiNoteId: null, sentAt: null, declinedAt: now + 100 },
    { id: 30, ankiNoteId: 203, sentAt: now + 100, declinedAt: null },
  ]);
  expect(await declinedCount(db)).toBe(1);
  expect(await sendPending(db, client)).toEqual({
    status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(client.addNotes).toHaveBeenCalledOnce();
  expect(client.sync).toHaveBeenCalledOnce();
});

test.each([
  { status: 'anki_closed', error: new AnkiUnreachableError('Anki is not running'), action: 'createDeck' },
  { status: 'anki_closed', error: new AnkiUnreachableError('Anki is not running'), action: 'addNotes' },
  { status: 'anki_closed', error: new AnkiUnreachableError('Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: fetch failed'), action: 'storeMediaFile' },
  { status: 'failed', error: new AnkiConnectError('Anki refused the request; check Anki settings.'), action: 'createDeck' },
  { status: 'failed', error: new AnkiConnectError('Anki refused the request; check Anki settings.'), action: 'addNotes' },
  { status: 'failed', error: new AnkiConnectError('Media write failed: disk full'), action: 'storeMediaFile' },
] as const)(
  'retryDeclined restores only the original declines when $action reports $status',
  async ({ status, error, action }) => {
    await db.update(cards).set({ declinedAt: 0 }).where(eq(cards.id, 10));
    await db.update(cards).set({ declinedAt: now - 50 }).where(eq(cards.id, 20));
    await db.update(cards).set({ audioFile: 'cached.mp3', audioMp3: Buffer.from([73, 68, 51]) })
      .where(eq(cards.id, 10));
    const before = await db.select().from(cards).orderBy(cards.id);
    const { client } = fakeClient([101, 102, 103]);
    client[action].mockRejectedValueOnce(error);

    expect(await retryDeclined(db, client)).toEqual({
      status, sent: 0, rejected: 0, pending: 1, syncedAt: null, message: error.message,
    });
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
    expect(await declinedCount(db)).toBe(2);
    expect(client.sync).not.toHaveBeenCalled();
  },
);

test.each(['createDeck', 'storeMediaFile', 'addNotes'] as const)(
  'retryDeclined restores the original decline timestamps before rethrowing an unexpected %s error',
  async (action) => {
    await db.update(cards).set({ declinedAt: 0 }).where(eq(cards.id, 10));
    await db.update(cards).set({ declinedAt: now - 50 }).where(eq(cards.id, 20));
    await db.update(cards).set({ audioFile: 'cached.mp3', audioMp3: Buffer.from([73, 68, 51]) })
      .where(eq(cards.id, 10));
    const before = await db.select().from(cards).orderBy(cards.id);
    const { client } = fakeClient([101, 102, 103]);
    const error = new Error('Unexpected client failure');
    client[action].mockRejectedValueOnce(error);

    await expect(retryDeclined(db, client)).rejects.toBe(error);

    expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
    expect(await declinedCount(db)).toBe(2);
    expect(client.sync).not.toHaveBeenCalled();
  },
);

test.each([
  { state: 'sent', result: 102, sentAt: now, declinedAt: null, count: 0 },
  { state: 'freshly declined', result: null, sentAt: null, declinedAt: now, count: 1 },
])('retryDeclined keeps a $state card unchanged when sync throws a plain Error', async ({
  result, sentAt, declinedAt, count,
}) => {
  await db.update(cards).set({ declinedAt: now - 50 }).where(eq(cards.id, 20));
  const { client } = fakeClient([101, result, 103]);
  const error = new Error('Unexpected sync failure');
  client.sync.mockRejectedValueOnce(error);

  await expect(retryDeclined(db, client)).rejects.toBe(error);

  expect(await db.select({
    ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt, declinedAt: cards.declinedAt,
  }).from(cards).where(eq(cards.id, 20)).get()).toEqual({ ankiNoteId: result, sentAt, declinedAt });
  expect(await declinedCount(db)).toBe(count);
  expect(client.addNotes).toHaveBeenCalledOnce();
  expect(client.sync).toHaveBeenCalledExactlyOnceWith();
});

test.each([
  { status: 'anki_closed', error: new AnkiUnreachableError('Anki is not running') },
  { status: 'failed', error: new AnkiConnectError('Anki refused the request; check Anki settings.') },
])('retryDeclined preserves sent cards and fresh declines when addNotes reports $status', async ({
  status, error,
}) => {
  await db.update(cards).set({ declinedAt: 0 }).where(inArray(cards.id, [10, 20, 30]));
  const { client } = fakeClient([]);
  client.addNotes.mockImplementationOnce(async () => {
    await db.update(cards).set({ ankiNoteId: 101, sentAt: now }).where(eq(cards.id, 10));
    await db.update(cards).set({ declinedAt: now }).where(eq(cards.id, 20));
    throw error;
  });

  expect(await retryDeclined(db, client)).toEqual({
    status, sent: 1, rejected: 1, pending: 0, syncedAt: null, message: error.message,
  });
  expect(await db.select({
    id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt, declinedAt: cards.declinedAt,
  }).from(cards).where(inArray(cards.id, [10, 20, 30])).orderBy(cards.id)).toEqual([
    { id: 10, ankiNoteId: 101, sentAt: now, declinedAt: null },
    { id: 20, ankiNoteId: null, sentAt: null, declinedAt: now },
    { id: 30, ankiNoteId: null, sentAt: null, declinedAt: 0 },
  ]);
  expect(await declinedCount(db)).toBe(2);
  expect(client.sync).not.toHaveBeenCalled();
});

test('declinedCount counts only non-null declines, including a zero timestamp', async () => {
  expect(await declinedCount(db)).toBe(0);
  await db.update(cards).set({ declinedAt: 0 }).where(eq(cards.id, 10));
  await db.update(cards).set({ declinedAt: now - 50 }).where(eq(cards.id, 20));
  expect(await declinedCount(db)).toBe(2);
  await db.update(cards).set({ declinedAt: null }).where(eq(cards.id, 20));
  expect(await declinedCount(db)).toBe(1);
  await db.delete(cards);
  expect(await declinedCount(db)).toBe(0);
});

test.each(['createDeck', 'addNotes'] as const)(
  'reports anki_closed and leaves every row unchanged when %s is unreachable',
  async (action) => {
    const { client } = fakeClient([101, null, 103]);
    client[action].mockRejectedValueOnce(new AnkiUnreachableError('Anki is not running'));
    const before = await db.select().from(cards).orderBy(cards.id);

    expect(await sendPending(db, client)).toEqual({
      status: 'anki_closed', sent: 0, rejected: 0, pending: 3, syncedAt: null, message: 'Anki is not running',
    });
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
    if (action === 'createDeck') expect(client.addNotes).not.toHaveBeenCalled();
    expect(client.sync).not.toHaveBeenCalled();
  },
);

test.each(['createDeck', 'addNotes'] as const)(
  'reports failed and leaves every row unchanged when %s throws an AnkiConnect error',
  async (action) => {
    const { client } = fakeClient([101, null, 103]);
    const error = new AnkiConnectError('Anki refused the request; check Anki settings.');
    client[action].mockRejectedValueOnce(error);
    const before = await db.select().from(cards).orderBy(cards.id);

    expect(await sendPending(db, client)).toEqual({
      status: 'failed', sent: 0, rejected: 0, pending: 3, syncedAt: null, message: error.message,
    });
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
    if (action === 'createDeck') expect(client.addNotes).not.toHaveBeenCalled();
    expect(client.sync).not.toHaveBeenCalled();
  },
);

test.each([
  new AnkiUnreachableError('Anki is not running'),
  new AnkiConnectError('AnkiWeb sync failed; check Anki settings.'),
])(
  'keeps committed card updates and reports sent with the message when sync throws $name',
  async (error) => {
    const { client } = fakeClient([101, null, 103]);
    client.sync.mockRejectedValueOnce(error);

    const report = await sendPending(db, client);

    expect(await db.select({
      id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt, declinedAt: cards.declinedAt,
    })
      .from(cards).orderBy(cards.id)).toEqual([
      { id: 10, ankiNoteId: 101, sentAt: now, declinedAt: null },
      { id: 15, ankiNoteId: 99, sentAt: now - 50, declinedAt: null },
      { id: 20, ankiNoteId: null, sentAt: null, declinedAt: now },
      { id: 25, ankiNoteId: null, sentAt: now - 50, declinedAt: null },
      { id: 30, ankiNoteId: 103, sentAt: now, declinedAt: null },
    ]);
    expect(report).toEqual({
      status: 'sent', sent: 2, rejected: 1, pending: 0, syncedAt: null, message: error.message,
    });
    expect(client.sync).toHaveBeenCalledExactlyOnceWith();
  },
);

test.each(['createDeck', 'addNotes', 'sync'] as const)(
  'propagates other client errors from %s',
  async (action) => {
    const { client } = fakeClient([101, 102, 103]);
    const error = new Error('Unexpected client failure');
    client[action].mockRejectedValueOnce(error);

    await expect(sendPending(db, client)).rejects.toBe(error);
    if (action === 'sync') {
      expect(await db.select({ id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt })
        .from(cards).orderBy(cards.id)).toEqual([
        { id: 10, ankiNoteId: 101, sentAt: now },
        { id: 15, ankiNoteId: 99, sentAt: now - 50 },
        { id: 20, ankiNoteId: 102, sentAt: now },
        { id: 25, ankiNoteId: null, sentAt: now - 50 },
        { id: 30, ankiNoteId: 103, sentAt: now },
      ]);
    }
  },
);

test.each(['empty', 'already sent'])(
  'makes no client calls when nothing is pending: %s',
  async (state) => {
    if (state === 'empty') await db.delete(cards);
    else await db.update(cards).set({ sentAt: now - 50 });
    const before = await db.select().from(cards).orderBy(cards.id);
    const { client, calls } = fakeClient([]);

    expect(await sendPending(db, client)).toEqual({
      status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null,
    });
    expect(calls).toEqual([]);
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
  },
);

test.each([{ results: [101, 102] }, { results: [101, 102, 103, 104] }])(
  'rejects a mismatched result count without changing rows: $results',
  async ({ results }) => {
    const { client } = fakeClient(results);
    const before = await db.select().from(cards).orderBy(cards.id);

    await expect(sendPending(db, client)).rejects.toThrow('AnkiConnect returned');
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
    expect(client.sync).not.toHaveBeenCalled();
  },
);

test.each(['not JSON', '[1]', '{}'])(
  'rejects invalid stored tags before making client calls: %s',
  async (tags) => {
    await db.update(cards).set({ tags }).where(eq(cards.id, 20));
    const before = await db.select().from(cards).orderBy(cards.id);
    const { client, calls } = fakeClient([101, 102, 103]);

    await expect(sendPending(db, client)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual(before);
  },
);
