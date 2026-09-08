import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { AnkiConnectError, AnkiUnreachableError, type AnkiClient } from '@/lib/anki/ankiConnect';
import type { Db } from '@/server/db';
import { cards } from '@/server/db/schema';
import { cardAudio } from './cardAudio';
import type { createSpanishVoice } from './spanishVoice';

const awaitingAudio = and(isNotNull(cards.sentAt), isNotNull(cards.ankiNoteId), isNull(cards.audioSentAt));

export type AudioBackfillReport = {
  status: 'sent' | 'anki_closed' | 'nothing' | 'failed';
  sent: number;
  rejected: number;
  awaitingAudio: number;
  unspeakable: number;
  message: string | null;
  failureStage: 'prepare' | 'synthesize' | 'cache' | 'storeMediaFile' | 'updateNoteFields' | 'markAudioSent' | null;
};

export async function awaitingAudioCount(db: Db): Promise<number> {
  return db.$count(cards, awaitingAudio);
}

async function storedAudioCounts(db: Db, ids: number[], rejectedIds: number[], unspeakableIds: number[]) {
  return {
    sent: await db.$count(cards, and(inArray(cards.id, ids), isNotNull(cards.audioSentAt))),
    rejected: await db.$count(cards, and(inArray(cards.id, rejectedIds), awaitingAudio)),
    awaitingAudio: await awaitingAudioCount(db),
    unspeakable: await db.$count(cards, and(inArray(cards.id, unspeakableIds), awaitingAudio)),
  };
}

export async function backfillSentAudio(
  db: Db,
  client: AnkiClient,
  voice: ReturnType<typeof createSpanishVoice>,
): Promise<AudioBackfillReport> {
  const pending = await db.select().from(cards).where(awaitingAudio).orderBy(cards.id);
  const rejectedIds: number[] = [];
  const unspeakableIds: number[] = [];
  let unspeakableMessage: string | null = null;
  let failureStage: AudioBackfillReport['failureStage'] = null;
  let message: string | null = null;
  let failureStatus: 'anki_closed' | 'failed' | undefined;
  let voiceFailed = false;

  for (const card of pending) {
    if (card.ankiNoteId === null) continue;
    let stage: NonNullable<AudioBackfillReport['failureStage']> = 'prepare';
    try {
      let { audioFile, audioMp3 } = card;
      if (!audioFile || !audioMp3) {
        const audio = cardAudio(card);
        if (voiceFailed) continue;
        stage = 'synthesize';
        let bytes: Uint8Array | undefined;
        try {
          bytes = await voice.synthesize(audio.text);
        } catch (error) {
          voiceFailed = true;
          if (failureStatus === undefined) {
            failureStatus = 'failed';
            failureStage = stage;
            message = error instanceof Error ? error.message : String(error);
          }
          continue;
        }
        if (bytes === undefined) continue;
        audioFile = audio.audioFile;
        audioMp3 = Buffer.from(bytes);
        stage = 'cache';
        await db.update(cards).set({ audioFile, audioMp3, audioSentAt: null }).where(eq(cards.id, card.id));
      }

      stage = 'storeMediaFile';
      const filename = await client.storeMediaFile(audioFile, audioMp3);
      stage = 'updateNoteFields';
      await client.updateNoteFields(card.ankiNoteId, { Back: `${card.back} [sound:${filename}]` });
      stage = 'markAudioSent';
      await db.update(cards).set({ audioSentAt: Date.now() }).where(eq(cards.id, card.id));
    } catch (error) {
      if (error instanceof Error && error.name === 'CardAudioError') {
        unspeakableIds.push(card.id);
        unspeakableMessage ??= error.message;
        continue;
      }
      if (failureStatus === undefined) {
        failureStatus = error instanceof AnkiUnreachableError ? 'anki_closed' : 'failed';
        failureStage = stage;
        message = error instanceof Error ? error.message : String(error);
      }
      if (error instanceof AnkiConnectError) {
        rejectedIds.push(card.id);
        continue;
      }
      break;
    }
  }

  const counts = await storedAudioCounts(db, pending.map((card) => card.id), rejectedIds, unspeakableIds);
  if (failureStatus === undefined && counts.unspeakable > 0) {
    failureStatus = 'failed';
    failureStage = 'prepare';
    message = unspeakableMessage;
  }
  return {
    status: failureStatus ?? (counts.sent > 0 ? 'sent' : 'nothing'),
    ...counts,
    failureStage,
    message,
  };
}
