import { z } from 'zod';

export type Card = {
  front: string;
  back: string;
  tags?: string[];
};

export type WordInfo = {
  english: string;
  spanish: string;
  gender: string | null;
  article: string | null;
  type: string;
  example: string | null;
  conjugations: {
    present?: Record<string, string>;
    preterite?: Record<string, string>;
    imperfect?: Record<string, string>;
    future?: Record<string, string>;
  } | null;
  error?: string;
};

export const WordInfoSchema = z.object({
  english: z.string(),
  spanish: z.string(),
  gender: z.string().nullable(),
  article: z.string().nullable(),
  type: z.string(),
  example: z.string().nullable(),
  conjugations: z
    .object({
      present: z.record(z.string()).optional(),
      preterite: z.record(z.string()).optional(),
      imperfect: z.record(z.string()).optional(),
      future: z.record(z.string()).optional(),
    })
    .nullable(),
  error: z.string().optional()
});

export const CardSchema = z.object({
  front: z.string(),
  back: z.string(),
  tags: z.array(z.string()).optional(),
});