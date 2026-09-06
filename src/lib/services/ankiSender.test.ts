import { createClient, type Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AnkiConnectError, AnkiUnreachableError, type AnkiClient } from '@/lib/anki/ankiConnect';
import { loadConfig } from '@/lib/config';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, words } from '@/server/db/schema';
import { sendPending, type SendReport } from './ankiSender';

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
    addNotes: vi.fn<AnkiClient['addNotes']>(async () => {
      calls.push('addNotes');
      return results;
    }),
    sync: vi.fn<AnkiClient['sync']>(async () => {
      calls.push('sync');
    }),
  } satisfies AnkiClient;
  return { client, calls };
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

test('sends pending cards in id order with configured note types, creates each deck once, and syncs', async () => {
  const { client, calls } = fakeClient([101, 102, 103]);
  const noteTypes = loadConfig().anki.noteTypes;
  const report: SendReport = await sendPending(db, client);

  expect(report).toEqual({ status: 'sent', sent: 3, rejected: 0, pending: 0, syncedAt: now, message: null });
  expect(calls).toEqual(['createDeck', 'createDeck', 'addNotes', 'sync']);
  expect(client.createDeck.mock.calls).toEqual([['Spanish::Vocab'], ['Spanish::Conjugation']]);
  expect(client.addNotes).toHaveBeenCalledExactlyOnceWith([
    {
      deckName: 'Spanish::Vocab', modelName: noteTypes.reversed,
      fields: { Front: 'house', Back: 'la casa' }, tags: ['auto-generated', 'vocab'],
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    },
    {
      deckName: 'Spanish::Vocab', modelName: noteTypes.basic,
      fields: { Front: 'La ____ es grande.', Back: 'casa (house)' }, tags: [],
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    },
    {
      deckName: 'Spanish::Conjugation', modelName: noteTypes.basic,
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

test('marks a null result rejected with sentAt only and does not send it again', async () => {
  const { client } = fakeClient([101, null, 103]);

  expect(await sendPending(db, client)).toEqual({
    status: 'sent', sent: 2, rejected: 1, pending: 0, syncedAt: now, message: null,
  });
  expect(await db.select({ id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt })
    .from(cards).orderBy(cards.id)).toEqual([
    { id: 10, ankiNoteId: 101, sentAt: now },
    { id: 15, ankiNoteId: 99, sentAt: now - 50 },
    { id: 20, ankiNoteId: null, sentAt: now },
    { id: 25, ankiNoteId: null, sentAt: now - 50 },
    { id: 30, ankiNoteId: 103, sentAt: now },
  ]);
  expect(client.sync).toHaveBeenCalledOnce();
  expect(await sendPending(db, client)).toEqual({
    status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null,
  });
  expect(client.addNotes).toHaveBeenCalledOnce();
  expect(client.sync).toHaveBeenCalledOnce();
});

test.each(['createDeck', 'addNotes'] as const)(
  'reports anki_closed and leaves every row unchanged when %s is unreachable',
  async (action) => {
    const { client } = fakeClient([101, null, 103]);
    client[action].mockRejectedValueOnce(new AnkiUnreachableError('Anki is not running'));
    const before = await db.select().from(cards).orderBy(cards.id);

    expect(await sendPending(db, client)).toEqual({
      status: 'anki_closed', sent: 0, rejected: 0, pending: 3, syncedAt: null, message: null,
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

    expect(await db.select({ id: cards.id, ankiNoteId: cards.ankiNoteId, sentAt: cards.sentAt })
      .from(cards).orderBy(cards.id)).toEqual([
      { id: 10, ankiNoteId: 101, sentAt: now },
      { id: 15, ankiNoteId: 99, sentAt: now - 50 },
      { id: 20, ankiNoteId: null, sentAt: now },
      { id: 25, ankiNoteId: null, sentAt: now - 50 },
      { id: 30, ankiNoteId: 103, sentAt: now },
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
