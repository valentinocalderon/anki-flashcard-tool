import { and, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { AnkiConnectError, AnkiUnreachableError, type AnkiClient } from '@/lib/anki/ankiConnect';
import type { Db } from '@/server/db';
import { cards } from '@/server/db/schema';
import type { SendReport } from './ankiSender';
import { cardAudio } from './cardAudio';
import type { createSpanishVoice } from './spanishVoice';

const awaitingAudio = and(isNotNull(cards.sentAt), isNotNull(cards.ankiNoteId), isNull(cards.audioSentAt));

async function storedAudioCounts(db: Db, ids: number[], rejectedIds: number[]) {
  return {
    sent: await db.$count(cards, and(inArray(cards.id, ids), isNotNull(cards.audioSentAt))),
    rejected: await db.$count(cards, and(inArray(cards.id, rejectedIds), awaitingAudio)),
    pending: await db.$count(cards, and(awaitingAudio, notInArray(cards.id, rejectedIds))),
  };
}

export async function backfillSentAudio(
  db: Db,
  client: AnkiClient,
  voice: ReturnType<typeof createSpanishVoice>,
): Promise<SendReport> {
  const pending = await db.select().from(cards).where(awaitingAudio).orderBy(cards.id);
  const rejectedIds: number[] = [];
  let message: string | null = null;
  let failureStatus: 'anki_closed' | 'failed' | undefined;
  let voiceFailed = false;

  for (const card of pending) {
    if (card.ankiNoteId === null) continue;
    try {
      let { audioFile, audioMp3 } = card;
      if (!audioFile || !audioMp3) {
        if (voiceFailed) continue;
        const audio = cardAudio(card);
        let bytes: Uint8Array | undefined;
        try {
          bytes = await voice.synthesize(audio.text);
        } catch (error) {
          voiceFailed = true;
          if (failureStatus === undefined) {
            failureStatus = 'failed';
            message = error instanceof Error ? error.message : String(error);
          }
          continue;
        }
        if (bytes === undefined) continue;
        audioFile = audio.audioFile;
        audioMp3 = Buffer.from(bytes);
        await db.update(cards).set({ audioFile, audioMp3, audioSentAt: null }).where(eq(cards.id, card.id));
      }

      const filename = await client.storeMediaFile(audioFile, audioMp3);
      await client.updateNoteFields(card.ankiNoteId, { Back: `${card.back} [sound:${filename}]` });
      await db.update(cards).set({ audioSentAt: Date.now() }).where(eq(cards.id, card.id));
    } catch (error) {
      if (error instanceof Error && error.name === 'CardAudioError') continue;
      if (failureStatus === undefined) {
        failureStatus = error instanceof AnkiUnreachableError ? 'anki_closed' : 'failed';
        message = error instanceof Error ? error.message : String(error);
      }
      if (error instanceof AnkiConnectError) {
        rejectedIds.push(card.id);
        continue;
      }
      break;
    }
  }

  const counts = await storedAudioCounts(db, pending.map((card) => card.id), rejectedIds);
  return {
    status: failureStatus ?? (counts.sent > 0 ? 'sent' : 'nothing'),
    ...counts,
    syncedAt: null,
    message,
  };
}
