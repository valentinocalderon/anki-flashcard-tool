import { and, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createAnkiClient } from '@/lib/anki/ankiConnect';
import { loadConfig } from '@/lib/config';
import { openaiLookup } from '@/lib/services/aiLookup';
import { declinedCount, retryDeclined, sendPending, type SendReport } from '@/lib/services/ankiSender';
import { backfillSentAudio } from '@/lib/services/audioBackfill';
import { generateForWords } from '@/lib/services/listGenerationService';
import { createSpanishVoice } from '@/lib/services/spanishVoice';
import type { WordResult } from '@/lib/types';
import { createTRPCRouter, publicProcedure } from '@/server/api/trpc';
import { getDb } from '@/server/db';
import { cards } from '@/server/db/schema';

export const ankiRouter = createTRPCRouter({
  generateFromList: publicProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{
      results: WordResult[]; capReached: boolean; send: SendReport; backfill: SendReport;
    }> => {
      const db = await getDb();
      const client = createAnkiClient(loadConfig().anki.url);
      const voice = createSpanishVoice(loadConfig().audio, fetch);
      const generation = await generateForWords(db, input.text, openaiLookup, fetch, voice);
      let send: SendReport;
      try {
        send = await sendPending(db, client);
      } catch (error) {
        send = {
          status: 'failed', sent: 0, rejected: 0,
          pending: await db.$count(cards, and(isNull(cards.sentAt), isNull(cards.declinedAt))),
          syncedAt: null, message: (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1).join(''),
        };
      }
      const backfill = await backfillSentAudio(db, client, voice);
      return { ...generation, capReached: voice.capReached, send, backfill };
    }),
  sendPending: publicProcedure.mutation(async (): Promise<{ send: SendReport; backfill: SendReport }> => {
    const db = await getDb();
    const client = createAnkiClient(loadConfig().anki.url);
    const voice = createSpanishVoice(loadConfig().audio, fetch);
    const send = await sendPending(db, client);
    const backfill = await backfillSentAudio(db, client, voice);
    return { send, backfill };
  }),
  retryDeclined: publicProcedure.mutation(async (): Promise<{ send: SendReport; backfill: SendReport }> => {
    const db = await getDb();
    const client = createAnkiClient(loadConfig().anki.url);
    const voice = createSpanishVoice(loadConfig().audio, fetch);
    const send = await retryDeclined(db, client);
    const backfill = await backfillSentAudio(db, client, voice);
    return { send, backfill };
  }),
  declinedCount: publicProcedure.query(async (): Promise<number> => {
    const db = await getDb();
    return declinedCount(db);
  }),
  pendingCount: publicProcedure.query(async (): Promise<number> => {
    const db = await getDb();
    return db.$count(cards, and(isNull(cards.sentAt), isNull(cards.declinedAt)));
  }),
});
