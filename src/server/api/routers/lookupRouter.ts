import { z } from 'zod';
import { openaiLookup } from '@/lib/services/aiLookup';
import { generateForWords } from '@/lib/services/listGenerationService';
import { createTRPCRouter, publicProcedure } from '@/server/api/trpc';
import { getDb } from '@/server/db';

export const ankiRouter = createTRPCRouter({
  generateFromList: publicProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      return generateForWords(db, input.text, openaiLookup);
    }),
});
