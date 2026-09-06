import { z } from 'zod';
import { createTRPCRouter, publicProcedure } from '@/server/api/trpc';
import { FlashcardGenerationService } from '@/lib/services/flashcardGenerationService';

export const ankiRouter = createTRPCRouter({
  getWordInfo: publicProcedure
    .input(z.object({ word: z.string().min(1) }))
    .query(async ({ input }) => {
      return await FlashcardGenerationService.generateFlashcard(input.word);
    }),
});
