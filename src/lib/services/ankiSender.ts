import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AnkiConnectError, AnkiUnreachableError, type AnkiClient, type AnkiNote } from '@/lib/anki/ankiConnect';
import { loadConfig } from '@/lib/config';
import type { Db } from '@/server/db';
import { cards } from '@/server/db/schema';

export type SendReport = {
  status: 'sent' | 'anki_closed' | 'nothing' | 'failed';
  sent: number;
  rejected: number;
  pending: number;
  syncedAt: number | null;
  message: string | null;
};

async function storedSendCounts(db: Db, ids: number[]) {
  const stored = await db.select({ sentAt: cards.sentAt, declinedAt: cards.declinedAt })
    .from(cards).where(inArray(cards.id, ids));
  return {
    sent: stored.filter((card) => card.sentAt !== null).length,
    rejected: stored.filter((card) => card.sentAt === null && card.declinedAt !== null).length,
    pending: await db.$count(cards, and(isNull(cards.sentAt), isNull(cards.declinedAt))),
  };
}

export async function sendPending(db: Db, client: AnkiClient): Promise<SendReport> {
  const pending = await db.select().from(cards)
    .where(and(isNull(cards.sentAt), isNull(cards.declinedAt))).orderBy(cards.id);
  if (pending.length === 0) {
    return { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null };
  }

  const { noteTypes } = loadConfig().anki;
  const notes: AnkiNote[] = pending.map((card) => ({
    deckName: card.deck,
    modelName: card.kind === 'basic' ? noteTypes.reversed : noteTypes.basic,
    fields: { Front: card.front, Back: card.back },
    tags: z.array(z.string()).parse(JSON.parse(card.tags)),
    options: { allowDuplicate: false, duplicateScope: 'deck' },
  }));

  let results: (number | null)[];
  try {
    for (const deck of new Set(pending.map((card) => card.deck))) {
      await client.createDeck(deck);
    }
    for (const [index, note] of notes.entries()) {
      const card = pending[index];
      if (card?.audioFile && card.audioMp3) {
        const filename = await client.storeMediaFile(card.audioFile, card.audioMp3);
        note.fields.Back += ` [sound:${filename}]`;
      }
    }
    results = await client.addNotes(notes);
  } catch (error) {
    if (!(error instanceof AnkiUnreachableError) && !(error instanceof AnkiConnectError)) throw error;
    return {
      status: error instanceof AnkiUnreachableError ? 'anki_closed' : 'failed',
      ...await storedSendCounts(db, pending.map((card) => card.id)),
      syncedAt: null, message: error.message,
    };
  }
  if (results.length !== pending.length) {
    throw new Error(
      `AnkiConnect returned ${results.length} results for ${pending.length} cards; check AnkiConnect and retry.`,
    );
  }

  const now = Date.now();
  let sent = 0;
  let rejected = 0;
  await db.transaction(async (tx) => {
    for (const [index, card] of pending.entries()) {
      const ankiNoteId = results[index];
      if (ankiNoteId === undefined) {
        throw new Error(`AnkiConnect returned no result for card ${card.id}; check AnkiConnect and retry.`);
      }
      if (ankiNoteId === null) {
        await tx.update(cards).set({ declinedAt: now }).where(eq(cards.id, card.id));
        rejected += 1;
      } else {
        await tx.update(cards).set({
          ankiNoteId, sentAt: now,
          ...(card.audioFile && card.audioMp3 ? { audioSentAt: now } : {}),
        }).where(eq(cards.id, card.id));
        sent += 1;
      }
    }
  });

  try {
    await client.sync();
  } catch (error) {
    if (!(error instanceof AnkiUnreachableError) && !(error instanceof AnkiConnectError)) throw error;
    return {
      status: 'sent', ...await storedSendCounts(db, pending.map((card) => card.id)),
      syncedAt: null, message: error.message,
    };
  }

  return { status: 'sent', sent, rejected, pending: 0, syncedAt: now, message: null };
}

export async function declinedCount(db: Db): Promise<number> {
  return db.$count(cards, isNotNull(cards.declinedAt));
}

export async function retryDeclined(db: Db, client: AnkiClient): Promise<SendReport> {
  const declined = await db.select({ id: cards.id, declinedAt: cards.declinedAt })
    .from(cards).where(isNotNull(cards.declinedAt));
  const ids = declined.map((card) => card.id);
  await db.transaction(async (tx) => {
    await tx.update(cards).set({ declinedAt: null }).where(inArray(cards.id, ids));
  });
  const restoreDeclines = async () => {
    await db.transaction(async (tx) => {
      for (const card of declined) {
        await tx.update(cards).set({ declinedAt: card.declinedAt })
          .where(and(eq(cards.id, card.id), isNull(cards.sentAt), isNull(cards.declinedAt)));
      }
    });
  };

  let report: SendReport;
  try {
    report = await sendPending(db, client);
  } catch (error) {
    await restoreDeclines();
    throw error;
  }
  if (report.status === 'anki_closed' || report.status === 'failed') {
    await restoreDeclines();
    report.pending = await db.$count(cards, and(isNull(cards.sentAt), isNull(cards.declinedAt)));
  }
  return report;
}
