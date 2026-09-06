import { isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createAnkiClient } from '@/lib/anki/ankiConnect';
import { loadConfig } from '@/lib/config';
import { openaiLookup } from '@/lib/services/aiLookup';
import { sendPending, type SendReport } from '@/lib/services/ankiSender';
import { generateForWords } from '@/lib/services/listGenerationService';
import type { WordResult } from '@/lib/types';
import { createTRPCRouter, publicProcedure } from '@/server/api/trpc';
import { getDb } from '@/server/db';
import { cards } from '@/server/db/schema';

export const ankiRouter = createTRPCRouter({
  generateFromList: publicProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ results: WordResult[]; send: SendReport }> => {
      const db = await getDb();
      const client = createAnkiClient(loadConfig().anki.url);
      const results = await generateForWords(db, input.text, openaiLookup);
      const send = await sendPending(db, client);
      return { results, send };
    }),
  sendPending: publicProcedure.mutation(async (): Promise<SendReport> => {
    const db = await getDb();
    const client = createAnkiClient(loadConfig().anki.url);
    return sendPending(db, client);
  }),
  pendingCount: publicProcedure.query(async (): Promise<number> => {
    const db = await getDb();
    return db.$count(cards, isNull(cards.sentAt));
  }),
});
